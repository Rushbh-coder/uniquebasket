'use strict';
/** Suppliers, purchase entry (stock inward + supplier ledger), stock adjustments and wastage. */
const { db, tx } = require('../db');
const v = require('../lib/validate');
const M = require('../lib/money');
const { BadRequest, NotFound, Conflict } = require('../lib/errors');
const { businessDate, isDate } = require('../lib/dates');
const inventory = require('./inventory');
const { audit } = require('./audit');
const rt = require('../realtime');

function cleanSupplier(b) {
  return { name: v.str(b.name, 'Supplier name', { required: true, max: 80 }), mobile: v.mobile(b.mobile), address: v.str(b.address, 'Address', { max: 200 }),
    gstin: v.gstin(b.gstin), creditDays: v.int(b.creditDays, 'Credit days', { min: 0, max: 365, def: 0 }), active: v.bool(b.active, true), notes: v.str(b.notes, 'Notes', { max: 200 }) };
}
/** supplier balance > 0 = shop owes supplier (payable) */
async function postSupplier(t, supplierId, { type, debit = 0, credit = 0, ref = '', refId = '', by = '' }) {
  if (!debit && !credit) return null;
  const s = await t.suppliers.findOneAndUpdate({ _id: supplierId }, { $inc: { balance: credit - debit } });
  if (!s) throw new BadRequest('Supplier not found');
  return t.supplier_ledger.insert({ supplierId, at: new Date().toISOString(), date: businessDate(), type, debit, credit, balance: s.balance, ref, refId, by });
}
async function createSupplier(req, b) {
  const doc = cleanSupplier(b);
  const opening = v.int(b.openingBalance, 'Opening balance', { min: -1e12, max: 1e12, def: 0 });
  return tx(async (t) => {
    const s = await t.settings.findOneAndUpdate({ _id: 'seq-supplier' }, { $inc: { v: 1 } }, { upsert: true });
    const sup = await t.suppliers.insert({ ...doc, code: 'S' + String(s.v).padStart(4, '0'), balance: 0, openingBalance: opening, createdAt: new Date().toISOString() });
    if (opening) await postSupplier(t, sup._id, { type: 'OPENING', credit: opening > 0 ? opening : 0, debit: opening < 0 ? -opening : 0, by: req.user.username, ref: 'Opening balance' });
    await audit(req, 'SUPPLIER_CREATED', { entity: 'supplier', entityId: sup._id, new: { name: sup.name } }, t);
    return t.suppliers.findOne({ _id: sup._id });
  }, 'supplier-create');
}
async function updateSupplier(req, id, b) {
  const cur = await db.c.suppliers.findOne({ _id: id }); if (!cur) throw new NotFound('Supplier not found');
  const doc = cleanSupplier({ ...cur, ...b });
  await db.c.suppliers.update({ _id: id }, { $set: doc });
  await audit(req, 'SUPPLIER_UPDATED', { entity: 'supplier', entityId: id, old: { name: cur.name, mobile: cur.mobile }, new: { name: doc.name, mobile: doc.mobile } });
  return db.c.suppliers.findOne({ _id: id });
}
/** purchase entry. items: [{productId, qty, rate (paise per unit), taxRate (bp)}], charges (paise), paid {mode, amount} */
async function createPurchase(req, b) {
  const supplierId = v.id(b.supplierId, 'Supplier');
  const invoiceNo = v.str(b.invoiceNo, 'Supplier invoice no', { max: 40 });
  const date = b.date ? (isDate(b.date) ? b.date : (() => { throw new BadRequest('Invoice date is invalid'); })()) : businessDate();
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new BadRequest('Add at least one item');
  const charges = v.int(b.charges, 'Other charges', { min: 0, max: 1e12, def: 0 });
  const paidAmt = v.int(b.paid && b.paid.amount, 'Paid amount', { min: 0, max: 1e12, def: 0 });
  const paidMode = v.oneOf(b.paid && b.paid.mode, 'Paid mode', ['CASH', 'UPI', 'BANK', 'CARD'], 'CASH');
  const sup = await db.c.suppliers.findOne({ _id: supplierId });
  if (!sup) throw new NotFound('Supplier not found');
  if (invoiceNo && await db.c.purchases.findOne({ supplierId, invoiceNo, status: { $ne: 'CANCELLED' } })) throw new Conflict('This supplier invoice is already entered');
  const lines = [];
  for (const [i, it] of items.entries()) {
    const p = await db.c.products.findOne({ _id: v.id(it.productId, 'Product') });
    if (!p) throw new BadRequest(`Line ${i + 1}: product not found`);
    const qty = v.int(it.qty, `Line ${i + 1} quantity`, { min: 1, max: 1e10 });
    const rate = v.int(it.rate, `Line ${i + 1} rate`, { min: 0, max: 1e10 });
    const taxRate = v.int(it.taxRate, `Line ${i + 1} GST`, { min: 0, max: 2800, def: 0 });
    const net = M.lineGross(p.unit, qty, rate);
    const tx_ = M.lineTax(net, taxRate, false);
    lines.push({ productId: p._id, name: p.name, unit: p.unit, qty, rate, taxRate, taxable: net, taxAmount: tx_.tax, amount: tx_.total });
  }
  const sub = lines.reduce((s, l) => s + l.taxable, 0), tax = lines.reduce((s, l) => s + l.taxAmount, 0);
  const total = sub + tax + charges;
  if (paidAmt > total) throw new BadRequest('Paid amount is more than the purchase total');
  const p = await tx(async (t) => {
    const s = await t.settings.findOneAndUpdate({ _id: 'seq-purchase' }, { $inc: { v: 1 } }, { upsert: true });
    const pur = await t.purchases.insert({ no: 'PUR-' + String(s.v).padStart(6, '0'), supplierId, supplierName: sup.name, invoiceNo, date, at: new Date().toISOString(), items: lines, sub, tax, charges, total, paid: paidAmt, paidMode, status: 'COMPLETED', paymentStatus: paidAmt >= total ? 'PAID' : paidAmt ? 'PARTIAL' : 'UNPAID', by: req.user.username });
    for (const l of lines) {
      await inventory.move(t, { productId: l.productId, qty: l.qty, type: 'PURCHASE', ref: pur.no, refId: pur._id, by: req.user.username });
      if (b.updatePurchaseRate !== false) await t.products.update({ _id: l.productId }, { $set: { purchaseRate: l.rate } });
    }
    await postSupplier(t, supplierId, { type: 'PURCHASE', credit: total, ref: pur.no + (invoiceNo ? ' / ' + invoiceNo : ''), refId: pur._id, by: req.user.username });
    if (paidAmt) await postSupplier(t, supplierId, { type: 'PAYMENT', debit: paidAmt, ref: `${pur.no} ${paidMode}`, refId: pur._id, by: req.user.username });
    await audit(req, 'PURCHASE_CREATED', { entity: 'purchase', entityId: pur._id, new: { no: pur.no, total } }, t);
    return pur;
  }, 'purchase');
  rt.emit('inventory:updated', { productIds: lines.map((l) => l.productId) });
  rt.emit('purchase:created', { no: p.no, total: p.total }, 'managers');
  return p;
}
async function paySupplier(req, id, b) {
  const amount = v.int(b.amount, 'Amount', { min: 1, max: 1e12 });
  const mode = v.oneOf(b.mode, 'Mode', ['CASH', 'UPI', 'BANK', 'CARD'], 'CASH');
  return tx(async (t) => {
    const r = await postSupplier(t, id, { type: 'PAYMENT', debit: amount, ref: mode + (b.ref ? ' ' + v.str(b.ref, 'Ref', { max: 60 }) : ''), by: req.user.username });
    await audit(req, 'SUPPLIER_PAYMENT', { entity: 'supplier', entityId: id, new: { amount, mode } }, t);
    return r;
  }, 'supplier-payment');
}
const WASTE_REASONS = ['SPOILAGE', 'DAMAGE', 'EXPIRY', 'HANDLING_LOSS', 'OTHER'];
/** stock adjustment (+/-) or wastage (always out). Manager only (route-level permission). */
async function adjust(req, b, kind) {
  const p = await db.c.products.findOne({ _id: v.id(b.productId, 'Product') });
  if (!p) throw new NotFound('Product not found');
  let qty = v.int(b.qty, 'Quantity', { min: -1e10, max: 1e10 });
  if (!qty) throw new BadRequest('Quantity cannot be zero');
  let reason;
  if (kind === 'WASTAGE') { if (qty < 0) qty = -qty; qty = -qty; reason = v.oneOf(b.reason, 'Reason', WASTE_REASONS); }
  else reason = v.str(b.reason, 'Reason', { required: true, min: 3, max: 120 });
  const note = v.str(b.note, 'Note', { max: 200 });
  const r = await tx(async (t) => {
    const row = await inventory.move(t, { productId: p._id, qty, type: kind, ref: kind === 'WASTAGE' ? 'Wastage' : 'Stock adjustment', by: req.user.username, reason: reason + (note ? ': ' + note : ''), terminal: req.terminal ? req.terminal.code : '' });
    await audit(req, kind === 'WASTAGE' ? 'WASTAGE' : 'STOCK_ADJUST', { entity: 'product', entityId: p._id, old: p.stock || 0, new: row.balance, reason, detail: `${p.name} ${qty}`, approvedBy: req.user.username }, t);
    return row;
  }, 'stock-' + kind);
  rt.emit('inventory:updated', { productIds: [p._id] });
  return r;
}
async function stockLedger(productId, { from, to, limit = 500 } = {}) {
  const q = { productId: v.id(productId, 'Product') };
  if (from || to) { q.date = {}; if (from) q.date.$gte = from; if (to) q.date.$lte = to; }
  return db.c.inventory.find(q, { sort: { at: 1 }, limit: Math.min(+limit || 500, 5000) });
}
module.exports = { createSupplier, updateSupplier, createPurchase, paySupplier, adjust, stockLedger, WASTE_REASONS, postSupplier };
