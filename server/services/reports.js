'use strict';
/** Reports. Each report reads only the requested date range (indexed on `date`) and aggregates in memory —
 *  a shop's daily volume (hundreds/thousands of bills) is small; never loads all history. */
const { db } = require('../db');
const v = require('../lib/validate');
const M = require('../lib/money');
const { BadRequest } = require('../lib/errors');
const { businessDate, isDate } = require('../lib/dates');
const { can, P } = require('../auth/rbac');
const terminals = require('./terminals');
const SOLD = ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'];

function range(q) {
  const from = q.from || q.date || businessDate(), to = q.to || q.date || from;
  if (!isDate(from) || !isDate(to)) throw new BadRequest('Dates must be YYYY-MM-DD');
  if (from > to) throw new BadRequest('From date is after To date');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 400) throw new BadRequest('Maximum range is 400 days');
  return { from, to, date: { $gte: from, $lte: to } };
}
async function bills(q, extra = {}) {
  const r = range(q); const f = { date: r.date, ...extra };
  if (q.terminal) f.terminalCode = v.str(q.terminal, 'terminal', { max: 20 });
  if (q.by) f.by = v.str(q.by, 'operator', { max: 40 });
  if (q.customerId) f.customerId = v.id(q.customerId);
  return { r, rows: await db.c.bills.find(f, { sort: { at: 1 } }) };
}
const add = (m, k, o) => { const x = m.get(k) || {}; for (const [a, b] of Object.entries(o)) x[a] = typeof b === 'number' ? (x[a] || 0) + b : b; m.set(k, x); return x; };
const payOf = (b, mode) => (b.payments || [{ mode: b.mode, amount: b.total }]).filter((p) => p.mode === mode).reduce((s, p) => s + p.amount, 0);

async function dashboard() {
  const today = businessDate();
  const [bl, rets, purchases, products, custs, tl, held] = await Promise.all([
    db.c.bills.find({ date: today }, { projection: { items: 0 } }), db.c.returns.find({ date: today }), db.c.purchases.find({ date: today, status: { $ne: 'CANCELLED' } }),
    db.c.products.find({ active: { $ne: false } }, { projection: { name: 1, stock: 1, minStock: 1, unit: 1 } }), db.c.customers.find({ balance: { $gt: 0 } }, { projection: { balance: 1 } }),
    terminals.list(), db.c.held_bills.count({}),
  ]);
  const sold = bl.filter((b) => SOLD.includes(b.status));
  const s = { date: today, sales: 0, bills: sold.length, cancelled: bl.length - sold.length, discounts: 0, tax: 0, CASH: 0, UPI: 0, CARD: 0, BANK: 0, CREDIT: 0, returns: 0, purchases: 0, outstanding: 0, lowStock: [], held };
  const counters = new Map();
  for (const b of sold) {
    s.sales += b.total; s.discounts += b.discount || 0; s.tax += b.tax || 0;
    for (const m of ['CASH', 'UPI', 'CARD', 'BANK', 'CREDIT']) s[m] += payOf(b, m);
    add(counters, b.terminalCode || b.counter || '-', { bills: 1, sales: b.total });
  }
  s.returns = rets.reduce((x, r) => x + r.amount, 0);
  s.netSales = s.sales - s.returns;
  s.purchases = purchases.reduce((x, p) => x + p.total, 0);
  s.outstanding = custs.reduce((x, c) => x + c.balance, 0);
  s.lowStock = products.filter((p) => p.minStock && (p.stock || 0) <= p.minStock).slice(0, 50);
  s.counters = tl.map((t) => ({ code: t.code, name: t.name, status: t.status, currentUser: t.currentUser || '', lastSeen: t.lastSeen || '', scaleStatus: t.scaleStatus || '', ...(counters.get(t.code) || { bills: 0, sales: 0 }) }));
  return s;
}

const REPORTS = {
  async daily(q) { const { rows } = await bills(q); const m = new Map(); for (const b of rows) { const sold = SOLD.includes(b.status); add(m, b.date, { date: b.date, bills: sold ? 1 : 0, sales: sold ? b.total : 0, discount: sold ? b.discount || 0 : 0, tax: sold ? b.tax || 0 : 0, cash: sold ? payOf(b, 'CASH') : 0, upi: sold ? payOf(b, 'UPI') : 0, card: sold ? payOf(b, 'CARD') : 0, credit: sold ? payOf(b, 'CREDIT') : 0, cancelled: sold ? 0 : 1 }); } return [...m.values()]; },
  async product(q) {
    const { rows } = await bills(q, { status: { $in: SOLD } }); const m = new Map(); const prof = q._profit;
    for (const b of rows) for (const l of b.items) { if (q.productId && l.productId !== q.productId) continue; const x = add(m, l.productId, { product: l.name, unit: l.unit, qty: l.qty, amount: l.amount, discount: l.discount || 0, lines: 1 }); if (prof) { x.cost = (x.cost || 0) + M.lineGross(l.unit, l.qty, l.purchaseRate || 0); x.margin = x.amount - x.cost; } }
    return [...m.values()].sort((a, b) => b.amount - a.amount);
  },
  async category(q) {
    const prods = new Map((await db.c.products.find({}, { projection: { category: 1 } })).map((p) => [p._id, p.category || 'Uncategorised']));
    const { rows } = await bills(q, { status: { $in: SOLD } }); const m = new Map();
    for (const b of rows) for (const l of b.items) add(m, prods.get(l.productId) || 'Uncategorised', { category: prods.get(l.productId) || 'Uncategorised', amount: l.amount, lines: 1 });
    return [...m.values()].sort((a, b) => b.amount - a.amount);
  },
  async operator(q) { const { rows } = await bills(q); const m = new Map(); for (const b of rows) { const s = SOLD.includes(b.status); add(m, b.by, { operator: b.by, bills: s ? 1 : 0, sales: s ? b.total : 0, discount: s ? b.discount || 0 : 0, cancelled: s ? 0 : 1 }); } return [...m.values()]; },
  async counter(q) { const { rows } = await bills(q); const m = new Map(); for (const b of rows) { const s = SOLD.includes(b.status); add(m, b.terminalCode || b.counter, { counter: b.terminalCode || b.counter, bills: s ? 1 : 0, sales: s ? b.total : 0, cash: s ? payOf(b, 'CASH') : 0, upi: s ? payOf(b, 'UPI') : 0, credit: s ? payOf(b, 'CREDIT') : 0 }); } return [...m.values()]; },
  async customer(q) { const { rows } = await bills(q, { status: { $in: SOLD } }); const m = new Map(); for (const b of rows) add(m, b.customerId || 'walkin:' + (b.customer || 'Walk-in'), { customer: b.customer || 'Walk-in', mobile: b.customerPhone || '', bills: 1, sales: b.total, credit: b.creditAmount || 0 }); return [...m.values()].sort((a, b) => b.sales - a.sales); },
  async payment(q) { const { rows } = await bills(q, { status: { $in: SOLD } }); const m = new Map(); for (const b of rows) for (const p of b.payments || [{ mode: b.mode, amount: b.total }]) add(m, p.mode, { mode: p.mode, count: 1, amount: p.amount }); return [...m.values()]; },
  async credit(q) { const { rows } = await bills(q, { status: { $in: SOLD }, creditAmount: { $gt: 0 } }); return rows.map((b) => ({ date: b.date, no: b.no, customer: b.customer, total: b.total, credit: b.creditAmount, by: b.by })); },
  async gst(q) {
    const { rows } = await bills(q, { status: { $in: SOLD } }); const m = new Map();
    for (const b of rows) for (const l of b.items) add(m, `${l.hsn || '-'}|${l.taxRate || 0}`, { hsn: l.hsn || '-', ratePct: (l.taxRate || 0) / 100, taxable: l.taxable || l.amount, cgst: Math.floor((l.taxAmount || 0) / 2), sgst: (l.taxAmount || 0) - Math.floor((l.taxAmount || 0) / 2), tax: l.taxAmount || 0, total: l.amount });
    return [...m.values()];
  },
  async discount(q) { const { rows } = await bills(q, { status: { $in: SOLD }, discount: { $gt: 0 } }); return rows.map((b) => ({ date: b.date, no: b.no, by: b.by, sub: b.sub, discount: b.discount, pct: (b.discountBp || 0) / 100, approvedBy: (b.approvals || {}).discount || '' })); },
  async cancelled(q) { const { rows } = await bills(q, { status: 'CANCELLED' }); return rows.map((b) => ({ date: b.date, no: b.no, total: b.total, by: b.by, cancelledBy: b.cancel ? b.cancel.by : '', approvedBy: b.cancel ? b.cancel.approvedBy : '', reason: b.cancelReason || '' })); },
  async returns(q) { const r = range(q); return (await db.c.returns.find({ date: r.date }, { sort: { at: 1 } })).map((x) => ({ date: x.date, billNo: x.billNo, items: x.items.map((i) => i.name).join(', '), amount: x.amount, refundMode: x.refundMode, by: x.by, reason: x.reason })); },
  async prices(q) { const r = range(q); return (await db.c.rates.find({ at: { $gte: r.from, $lte: r.to + 'T23:59:59.999Z~' } }, { sort: { at: -1 } })).map((x) => ({ at: x.at, product: x.productName, old: x.old, rate: x.rate, by: x.by, reason: x.reason || '' })); },
  async purchases(q) { const r = range(q); return (await db.c.purchases.find({ date: r.date }, { sort: { at: 1 } })).map((p) => ({ date: p.date, no: p.no, supplier: p.supplierName, invoiceNo: p.invoiceNo, items: p.items.length, total: p.total, paid: p.paid, status: p.paymentStatus })); },
  async stock() { return (await db.c.products.find({}, { sort: { name: 1 } })).map((p) => ({ product: p.name, category: p.category || '', unit: p.unit, stock: p.stock || 0, minStock: p.minStock || 0, low: !!(p.minStock && (p.stock || 0) <= p.minStock), active: p.active !== false })); },
  async lowstock() { return (await REPORTS.stock()).filter((x) => x.low && x.active); },
  async wastage(q) { const r = range(q); return (await db.c.inventory.find({ date: r.date, type: 'WASTAGE' }, { sort: { at: 1 } })).map((x) => ({ date: x.date, product: x.productName, unit: x.unit, qty: x.out, reason: x.reason, by: x.by })); },
  async outstanding() { return (await db.c.customers.find({ balance: { $gt: 0 } }, { sort: { balance: -1 } })).map((c) => ({ code: c.code, customer: c.name, mobile: c.mobile, balance: c.balance, creditLimit: c.creditLimit || 0 })); },
  async suppliers() { return (await db.c.suppliers.find({}, { sort: { name: 1 } })).map((s) => ({ code: s.code, supplier: s.name, mobile: s.mobile, payable: s.balance || 0 })); },
  async shifts(q) { const r = range(q); return (await db.c.cash_sessions.find({ openedAt: { $gte: r.from, $lte: r.to + '~' } }, { sort: { openedAt: -1 } })).map((s) => ({ counter: s.terminalCode, operator: s.username, opened: s.openedAt, closed: s.closedAt || '', opening: s.openingCash, expected: s.expectedCash == null ? null : s.expectedCash, actual: s.actualCash == null ? null : s.actualCash, difference: s.difference == null ? null : s.difference, status: s.status })); },
};
const PROFIT_ONLY = ['profit'];
async function run(req, name, q) {
  if (name === 'profit') { if (!can(req.user.role, P.REPORT_PROFIT)) throw new BadRequest('Profit report is restricted'); return REPORTS.product({ ...q, _profit: true }); }
  const fn = REPORTS[name]; if (!fn) throw new BadRequest('Unknown report');
  return fn(q);
}
/** CSV with paise columns converted to rupees */
const MONEY = /^(sales|amount|discount|tax|cash|upi|card|credit|total|paid|balance|creditLimit|payable|sub|old|rate|taxable|cgst|sgst|cost|margin|opening|expected|actual|difference)$/;
function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows.reduce((a, r) => Object.assign(a, r), {}));
  const esc = (x) => { const s = x == null ? '' : String(x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(MONEY.test(c) && typeof r[c] === 'number' ? (r[c] / 100).toFixed(2) : r[c])).join(','))].join('\r\n');
}
module.exports = { dashboard, run, csv, NAMES: Object.keys(REPORTS).concat(PROFIT_ONLY) };
