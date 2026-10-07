'use strict';
const { db, tx } = require('../db');
const v = require('../lib/validate');
const { UNITS, unitInfo } = require('../lib/money');
const { BadRequest, NotFound, Conflict } = require('../lib/errors');
const { audit } = require('./audit');
const inventory = require('./inventory');
const rt = require('../realtime');
const log = require('../lib/log');

/** fields sent to billing screens (no purchase rate = no margin leak to operators) */
const posView = (p) => ({ _id: p._id, code: p.code || '', barcode: p.barcode || '', name: p.name, localName: p.localName || '', category: p.category || '',
  unit: p.unit, rate: p.rate, mrp: p.mrp || 0, taxRate: p.taxRate || 0, hsn: p.hsn || '', weighable: !!p.weighable, allowManualWeight: p.allowManualWeight !== false,
  allowManualRate: !!p.allowManualRate, minRate: p.minRate || 0, maxDiscountBp: p.maxDiscountBp || 0, unitWeight: p.unitWeight || 0, active: p.active !== false,
  stock: p.stock || 0, priceVersion: p.priceVersion || 0, updatedAt: p.updatedAt || '' });

function clean(b, existing) {
  const unit = v.oneOf(b.unit, 'Unit', Object.keys(UNITS), existing ? existing.unit : 'KG');
  const o = {
    name: v.str(b.name, 'Product name', { required: true, max: 80 }),
    code: v.str(b.code, 'Product code', { max: 20, pattern: /^[A-Za-z0-9_-]*$/ }).toUpperCase(),
    barcode: v.str(b.barcode, 'Barcode', { max: 32, pattern: /^[A-Za-z0-9]*$/ }),
    localName: v.str(b.localName, 'Local name', { max: 80 }),
    category: v.str(b.category, 'Category', { max: 40 }),
    subcategory: v.str(b.subcategory, 'Subcategory', { max: 40 }),
    unit,
    purchaseRate: v.int(b.purchaseRate, 'Purchase rate', { min: 0, max: 1e10, def: 0 }),
    mrp: v.int(b.mrp, 'MRP', { min: 0, max: 1e10, def: 0 }),
    taxRate: v.int(b.taxRate, 'GST rate', { min: 0, max: 2800, def: 0 }),
    hsn: v.str(b.hsn, 'HSN/SAC', { max: 10, pattern: /^\d*$/ }),
    weighable: b.weighable == null ? unitInfo(unit).weighed : v.bool(b.weighable),
    allowManualWeight: v.bool(b.allowManualWeight, true),
    allowManualRate: v.bool(b.allowManualRate, false),
    minRate: v.int(b.minRate, 'Minimum price', { min: 0, max: 1e10, def: 0 }),
    maxDiscountBp: v.int(b.maxDiscountBp, 'Max discount', { min: 0, max: 10000, def: 0 }),
    minStock: v.int(b.minStock, 'Minimum stock', { min: 0, max: 1e12, def: 0 }),
    unitWeight: v.int(b.unitWeight, 'Weight of one piece', { min: 0, max: 1e7, def: 0 }),
    active: v.bool(b.active, true),
  };
  if (o.weighable && !unitInfo(unit).weighed) throw new BadRequest('Only KG / LITRE products can be weighed');
  if (o.code === '') delete o.code; if (o.barcode === '') delete o.barcode;
  return o;
}
async function list({ all = false } = {}) {
  const q = all ? {} : { active: { $ne: false } };
  return db.c.products.find(q, { sort: { name: 1 } });
}
async function create(req, b) {
  const doc = clean(b);
  const rate = v.int(b.rate, 'Sale rate', { min: 0, max: 1e10 });
  if (doc.minRate && rate < doc.minRate) throw new BadRequest('Sale rate is below minimum price');
  const opening = v.int(b.openingStock, 'Opening stock', { min: 0, max: 1e12, def: 0 });
  const now = new Date().toISOString();
  const p = await tx(async (t) => {
    const p = await t.products.insert({ ...doc, rate, stock: 0, priceVersion: 1, createdAt: now, updatedAt: now });
    await t.rates.insert({ productId: p._id, productName: p.name, old: null, rate, version: 1, at: now, effectiveAt: now, by: req.user.username, terminal: req.terminal ? req.terminal.code : '', reason: 'Created' });
    if (opening) await inventory.move(t, { productId: p._id, qty: opening, type: 'OPENING', by: req.user.username, ref: 'Opening stock' });
    await audit(req, 'PRODUCT_CREATED', { entity: 'product', entityId: p._id, new: { name: p.name, rate } }, t);
    return t.products.findOne({ _id: p._id });
  }, 'product-create').catch(dupMsg);
  rt.emit('product:created', posView(p));
  return p;
}
const dupMsg = (e) => { if (e.duplicateKey) throw new Conflict('Product code or barcode already used by another product'); throw e; };
async function update(req, id, b) {
  const cur = await db.c.products.findOne({ _id: id });
  if (!cur) throw new NotFound('Product not found');
  const doc = clean({ ...cur, ...b }, cur);
  const p = await tx(async (t) => {
    const unset = {}; if (!doc.code && cur.code) unset.code = 1; if (!doc.barcode && cur.barcode) unset.barcode = 1;
    const u = { $set: { ...doc, updatedAt: new Date().toISOString() } }; if (Object.keys(unset).length) u.$unset = unset;
    await t.products.update({ _id: id }, u);
    const changed = {}; for (const k of Object.keys(doc)) if (JSON.stringify(doc[k]) !== JSON.stringify(cur[k])) changed[k] = [cur[k] === undefined ? null : cur[k], doc[k]];
    if (Object.keys(changed).length) await audit(req, cur.active !== false && doc.active === false ? 'PRODUCT_DISABLED' : 'PRODUCT_UPDATED', { entity: 'product', entityId: id, old: Object.fromEntries(Object.entries(changed).map(([k, x]) => [k, x[0]])), new: Object.fromEntries(Object.entries(changed).map(([k, x]) => [k, x[1]])) }, t);
    return t.products.findOne({ _id: id });
  }, 'product-update').catch(dupMsg);
  rt.emit(cur.active !== p.active ? 'product:status-changed' : 'product:updated', posView(p));
  return p;
}
/**
 * Change sale rate. effectiveAt in the future -> scheduled, applied automatically by the ticker.
 * History is append-only; old invoices keep their own snapshot so they never change.
 */
async function changePrice(req, id, { rate, effectiveAt, reason }) {
  rate = v.int(rate, 'New rate', { min: 0, max: 1e10 });
  reason = v.str(reason, 'Reason', { max: 120 });
  const p = await db.c.products.findOne({ _id: id });
  if (!p) throw new NotFound('Product not found');
  if (p.minRate && rate < p.minRate) throw new BadRequest('New rate is below the minimum price for this product');
  const when = effectiveAt ? new Date(effectiveAt) : new Date();
  if (isNaN(when)) throw new BadRequest('Effective date/time is invalid');
  if (when.getTime() > Date.now() + 1000) {
    const s = await db.c.price_schedule.insert({ productId: id, productName: p.name, rate, effectiveAt: when.toISOString(), status: 'PENDING', by: req.user.username, reason, terminal: req.terminal ? req.terminal.code : '', at: new Date().toISOString() });
    await audit(req, 'PRICE_SCHEDULED', { entity: 'product', entityId: id, old: p.rate, new: rate, reason, detail: 'effective ' + s.effectiveAt });
    rt.emit('product:price-scheduled', { productId: id, rate, effectiveAt: s.effectiveAt }, 'managers');
    return { scheduled: true, schedule: s };
  }
  return { scheduled: false, product: await applyPrice({ productId: id, rate, by: req.user.username, reason, terminal: req.terminal ? req.terminal.code : '', ctx: req, effectiveAt: when.toISOString() }) };
}
async function applyPrice({ productId, rate, by, reason, terminal, ctx, effectiveAt, scheduleId }) {
  const now = new Date().toISOString();
  let old = null;
  const p = await tx(async (t) => {
    const cur = await t.products.findOne({ _id: productId });
    if (!cur) throw new NotFound('Product not found');
    old = cur.rate;
    if (cur.rate === rate) { if (scheduleId) await t.price_schedule.update({ _id: scheduleId }, { $set: { status: 'APPLIED', appliedAt: now } }); return cur; }
    const version = (cur.priceVersion || 0) + 1;
    await t.products.update({ _id: productId }, { $set: { rate, priceVersion: version, updatedAt: now } });
    await t.rates.insert({ productId, productName: cur.name, old: cur.rate, rate, version, at: now, effectiveAt: effectiveAt || now, by, terminal, reason });
    if (scheduleId) await t.price_schedule.update({ _id: scheduleId }, { $set: { status: 'APPLIED', appliedAt: now } });
    await audit(ctx || { user: { username: by } }, 'PRICE_CHANGE', { entity: 'product', entityId: productId, old: cur.rate, new: rate, reason, detail: cur.name }, t);
    return t.products.findOne({ _id: productId });
  }, 'price-change');
  // minimal validated payload to every counter
  if (old === p.rate) return p; // nothing changed: no event, no "rate changed" message on the counters
  rt.emit('product:price-updated', { productId: p._id, name: p.name, old, rate: p.rate, priceVersion: p.priceVersion, unit: p.unit, by, at: now });
  return p;
}
async function cancelSchedule(req, sid) {
  const s = await db.c.price_schedule.findOne({ _id: sid, status: 'PENDING' });
  if (!s) throw new NotFound('Scheduled price not found');
  await db.c.price_schedule.update({ _id: sid }, { $set: { status: 'CANCELLED', cancelledBy: req.user.username } });
  await audit(req, 'PRICE_SCHEDULE_CANCELLED', { entity: 'product', entityId: s.productId, new: s.rate });
}
let ticker = null;
function startScheduler() {
  const run = async () => {
    try {
      const due = await db.c.price_schedule.find({ status: 'PENDING', effectiveAt: { $lte: new Date().toISOString() } }, { sort: { effectiveAt: 1 } });
      for (const s of due) await applyPrice({ productId: s.productId, rate: s.rate, by: s.by, reason: s.reason || 'Scheduled', terminal: s.terminal, effectiveAt: s.effectiveAt, scheduleId: s._id });
    } catch (e) { log.error('price scheduler', e); }
  };
  run(); ticker = setInterval(run, 15000); ticker.unref && ticker.unref();
  return run;
}
const stopScheduler = () => clearInterval(ticker);
async function history(productId, { limit = 200 } = {}) {
  const q = productId ? { productId } : {};
  return db.c.rates.find(q, { sort: { at: -1 }, limit });
}
/** the rate that was effective for a product at time `iso` (used to honour rates quoted on an open bill) */
async function rateAt(productId, iso) {
  const after = await db.c.rates.find({ productId, at: { $gt: iso } }, { sort: { at: 1 }, limit: 1 });
  if (after.length) return after[0].old;
  const p = await db.c.products.findOne({ _id: productId });
  return p ? p.rate : null;
}
module.exports = { list, create, update, changePrice, applyPrice, cancelSchedule, startScheduler, stopScheduler, history, rateAt, posView, clean };
