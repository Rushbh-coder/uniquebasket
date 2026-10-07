'use strict';
/** Customers + customer ledger. balance > 0 means the customer owes the shop (receivable). */
const { db, tx } = require('../db');
const v = require('../lib/validate');
const { BadRequest, NotFound, Conflict } = require('../lib/errors');
const { businessDate } = require('../lib/dates');
const { audit } = require('./audit');
const rt = require('../realtime');

const TYPES = ['RETAIL', 'WHOLESALE', 'HOTEL', 'VENDOR', 'OTHER'];
function clean(b) {
  return {
    name: v.str(b.name, 'Customer name', { required: true, max: 80 }),
    mobile: v.mobile(b.mobile),
    address: v.str(b.address, 'Address', { max: 200 }),
    gstin: v.gstin(b.gstin),
    type: v.oneOf(b.type, 'Customer type', TYPES, 'RETAIL'),
    creditAllowed: v.bool(b.creditAllowed, false),
    creditLimit: v.int(b.creditLimit, 'Credit limit', { min: 0, max: 1e12, def: 0 }),
    creditDays: v.int(b.creditDays, 'Credit days', { min: 0, max: 365, def: 0 }),
    notes: v.str(b.notes, 'Notes', { max: 300 }),
    active: v.bool(b.active, true),
  };
}
async function nextCode(t) {
  const s = await t.settings.findOneAndUpdate({ _id: 'seq-customer' }, { $inc: { v: 1 } }, { upsert: true });
  return 'C' + String(s.v).padStart(5, '0');
}
/** ledger row + balance update, inside a transaction. debit increases what customer owes. */
async function post(t, customerId, { type, debit = 0, credit = 0, ref = '', refId = '', by = '', note = '' }) {
  if (!debit && !credit) return null;
  const c = await t.customers.findOneAndUpdate({ _id: customerId }, { $inc: { balance: debit - credit } });
  if (!c) throw new BadRequest('Customer not found');
  return t.customer_ledger.insert({ customerId, at: new Date().toISOString(), date: businessDate(), type, debit, credit, balance: c.balance, ref, refId, by, note });
}
async function create(req, b) {
  const doc = clean(b);
  const opening = v.int(b.openingBalance, 'Opening balance', { min: -1e12, max: 1e12, def: 0 });
  if (doc.mobile && await db.c.customers.findOne({ mobile: doc.mobile, active: { $ne: false } })) throw new Conflict('A customer with this mobile already exists');
  const c = await tx(async (t) => {
    const code = await nextCode(t);
    const c = await t.customers.insert({ ...doc, code, openingBalance: opening, balance: 0, createdAt: new Date().toISOString(), createdBy: req.user.username });
    if (opening) await post(t, c._id, { type: 'OPENING', debit: opening > 0 ? opening : 0, credit: opening < 0 ? -opening : 0, by: req.user.username, ref: 'Opening balance' });
    await audit(req, 'CUSTOMER_CREATED', { entity: 'customer', entityId: c._id, new: { name: c.name, mobile: c.mobile } }, t);
    return t.customers.findOne({ _id: c._id });
  }, 'customer-create');
  rt.emit('customer:updated', c);
  return c;
}
async function update(req, id, b) {
  const cur = await db.c.customers.findOne({ _id: id });
  if (!cur) throw new NotFound('Customer not found');
  const doc = clean({ ...cur, ...b });
  const { P, can } = { ...require('../auth/rbac') };
  if ((doc.creditLimit !== cur.creditLimit || doc.creditAllowed !== !!cur.creditAllowed) && !can(req.user.role, P.CUSTOMER_EDIT)) throw new BadRequest('Only a manager can change credit settings');
  await db.c.customers.update({ _id: id }, { $set: { ...doc, updatedAt: new Date().toISOString() } });
  await audit(req, 'CUSTOMER_UPDATED', { entity: 'customer', entityId: id, old: { creditLimit: cur.creditLimit, creditAllowed: cur.creditAllowed, name: cur.name, mobile: cur.mobile }, new: { creditLimit: doc.creditLimit, creditAllowed: doc.creditAllowed, name: doc.name, mobile: doc.mobile } });
  const c = await db.c.customers.findOne({ _id: id });
  rt.emit('customer:updated', c);
  return c;
}
async function search(q, { limit = 30, all = false } = {}) {
  const s = String(q || '').trim();
  const base = all ? {} : { active: { $ne: false } };
  if (!s) return db.c.customers.find(base, { sort: { name: 1 }, limit });
  const r = new RegExp(v.rx(s), 'i');
  return db.c.customers.find({ ...base, $or: [{ name: r }, { mobile: r }, { code: r }] }, { sort: { name: 1 }, limit });
}
/** receive payment against outstanding */
async function receivePayment(req, id, b) {
  const amount = v.int(b.amount, 'Amount', { min: 1, max: 1e12 });
  const mode = v.oneOf(b.mode, 'Payment mode', ['CASH', 'UPI', 'CARD', 'BANK'], 'CASH');
  const ref = v.str(b.ref, 'Reference', { max: 60 });
  const r = await tx(async (t) => {
    const c = await t.customers.findOne({ _id: id }); if (!c) throw new NotFound('Customer not found');
    const row = await post(t, id, { type: 'PAYMENT', credit: amount, ref: `${mode}${ref ? ' ' + ref : ''}`, by: req.user.username, note: v.str(b.note, 'Note', { max: 120 }) });
    await audit(req, 'CUSTOMER_PAYMENT', { entity: 'customer', entityId: id, new: { amount, mode } }, t);
    return { row, mode, terminalId: req.terminal ? req.terminal._id : null };
  }, 'customer-payment');
  rt.emit('customer:payment', { customerId: id, amount, mode }, 'managers');
  return r.row;
}
async function ledger(id, { from, to } = {}) {
  const c = await db.c.customers.findOne({ _id: id });
  if (!c) throw new NotFound('Customer not found');
  const all = await db.c.customer_ledger.find({ customerId: id }, { sort: { at: 1 } });
  let opening = 0; const rows = [];
  for (const r of all) {
    if (from && r.date < from) { opening = r.balance; continue; }
    if (to && r.date > to) continue;
    rows.push(r);
  }
  const debit = rows.reduce((s, r) => s + r.debit, 0), credit = rows.reduce((s, r) => s + r.credit, 0);
  return { customer: c, opening, rows, debit, credit, closing: opening + debit - credit };
}
/** Called inside the bill transaction. The customer typed on the Sale Entry screen is stored automatically:
 *  unknown mobile -> new customer; known customer -> name / address updated when the operator changed them. */
async function saveFromBill(t, req, cust, { name, mobile, address }) {
  const now = new Date().toISOString();
  if (!cust && mobile) cust = await t.customers.findOne({ mobile, active: { $ne: false } }); // re-check inside the lock: two counters, same new number
  if (!cust) {
    const c = await t.customers.insert({ name: name || mobile, mobile, address, gstin: '', type: 'RETAIL', creditAllowed: false, creditLimit: 0, creditDays: 0, notes: '', active: true,
      code: await nextCode(t), openingBalance: 0, balance: 0, createdAt: now, createdBy: req.user.username });
    await audit(req, 'CUSTOMER_CREATED', { entity: 'customer', entityId: c._id, new: { name: c.name, mobile: c.mobile }, detail: 'from bill' }, t);
    return c;
  }
  const set = {};
  if (name && name !== cust.name) set.name = name;
  if (address && address !== (cust.address || '')) set.address = address;
  if (!Object.keys(set).length) return cust;
  await t.customers.update({ _id: cust._id }, { $set: { ...set, updatedAt: now } });
  await audit(req, 'CUSTOMER_UPDATED', { entity: 'customer', entityId: cust._id, old: { name: cust.name, address: cust.address || '' }, new: set, detail: 'from bill' }, t);
  return { ...cust, ...set };
}
module.exports = { saveFromBill, create, update, search, post, receivePayment, ledger, clean, TYPES };
