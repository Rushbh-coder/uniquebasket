'use strict';
/**
 * Sales invoices ("bills" collection, name kept for compatibility with existing data).
 * The client never decides money: every line, discount, tax and total is recalculated here from the product master,
 * and the whole sale (invoice + numbering + payments + stock + customer ledger + audit) commits in ONE transaction.
 */
const { db, tx } = require('../db');
const v = require('../lib/validate');
const M = require('../lib/money');
const { BadRequest, NotFound, Forbidden, Conflict, ApprovalRequired } = require('../lib/errors');
const { businessDate, financialYear } = require('../lib/dates');
const { P, can } = require('../auth/rbac');
const auth = require('../auth');
const settings = require('./settings');
const inventory = require('./inventory');
const customers = require('./customers');
const products = require('./products');
const reading = require('../lib/reading');
const { audit } = require('./audit');
const rt = require('../realtime');

const PAY_MODES = ['CASH', 'UPI', 'CARD', 'BANK', 'CREDIT'];
const SALE_MODES = ['RETAIL', 'WHOLESALE'];
const QUOTE_WINDOW_MS = 12 * 3600e3;

/** build validated lines + totals (no writes). Used by complete() and by /preview. */
async function price(req, body, conf) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new BadRequest('Add at least one item');
  if (items.length > 300) throw new BadRequest('Too many lines in one bill');
  const approvals = body.approvals || {};
  const approvedBy = {};
  // shop setting: when off, billing never asks for a manager PIN (overrides are still written to the audit log)
  const strict = !!conf.billing.operatorApprovals;
  const lines = []; const notes = [];
  const term = req.terminal;
  for (const [i, it] of items.entries()) {
    const p = await db.c.products.findOne({ _id: v.id(it.productId, 'Product') });
    if (!p || p.active === false) throw new BadRequest(`Line ${i + 1}: product is not available`);
    const ui = M.unitInfo(p.unit);
    const qty = v.int(it.qty, `Line ${i + 1} quantity`, { min: 1, max: 1e9 });
    // ----- rate -----
    let rate = p.rate, rateSrc = 'MASTER';
    if (it.rate != null && +it.rate !== p.rate) {
      const r = v.int(it.rate, `Line ${i + 1} rate`, { min: 0, max: 1e10 });
      const quoted = typeof it.quotedAt === 'string' && Date.now() - Date.parse(it.quotedAt) < QUOTE_WINDOW_MS ? await products.rateAt(p._id, it.quotedAt) : null;
      if (quoted === r) { rate = r; rateSrc = 'QUOTED'; notes.push(`${p.name}: kept rate ₹${M.rupees(r)} from when it was added`); }
      else {
        if (strict && !p.allowManualRate && !can(req.user.role, P.RATE_OVERRIDE)) {
          const a = auth.checkApproval(approvals.rate_override, 'rate_override');
          if (!a) throw new ApprovalRequired(`Rate change for ${p.name} needs manager approval`, 'rate_override');
          approvedBy.rate_override = a;
        } else if (!can(req.user.role, P.RATE_OVERRIDE) && p.allowManualRate) { /* product allows operator rate entry */ }
        if (p.minRate && r < p.minRate && !can(req.user.role, P.PRICE_EDIT)) throw new BadRequest(`${p.name}: rate below minimum price ₹${M.rupees(p.minRate)}`);
        rate = r; rateSrc = 'MANUAL';
      }
    }
    // ----- weight / quantity source -----
    let src = 'COUNT', tare = 0, gross = qty;
    if (ui.weighed) {
      tare = v.int(it.tare, `Line ${i + 1} tare`, { min: 0, max: 1e9, def: 0 });
      const rd = it.reading;
      const secret = term && term.scaleSecret;
      const okSig = rd && reading.verify(secret, rd, term ? term.code : '') && (!rd.mock || conf.billing.allowMockScale);
      if (okSig && v.int(rd.grams, 'Scale reading', { min: 0, max: 1e9 }) - tare === qty) { src = 'SCALE'; gross = rd.grams; }
      else {
        src = 'MANUAL'; gross = qty + tare;
        const selfOk = !strict || can(req.user.role, P.WEIGHT_MANUAL) || (!conf.billing.manualWeightNeedsApproval && p.allowManualWeight !== false);
        if (!selfOk) {
          const a = auth.checkApproval(approvals.weight_manual, 'weight_manual');
          if (!a) throw new ApprovalRequired(`Manual weight for ${p.name} needs manager approval`, 'weight_manual');
          approvedBy.weight_manual = a;
        }
        if (strict && p.allowManualWeight === false && !can(req.user.role, P.WEIGHT_MANUAL) && !approvedBy.weight_manual) throw new Forbidden(`${p.name} must be weighed on the scale`);
      }
    }
    const grossAmt = M.lineGross(p.unit, qty, rate);
    lines.push({ productId: p._id, code: p.code || '', name: p.name, localName: p.localName || '', hsn: p.hsn || '', unit: p.unit, qty, tare, grossWeight: ui.weighed ? gross : 0,
      rate, rateSrc, mrp: p.mrp || 0, taxRate: p.taxRate || 0, purchaseRate: p.purchaseRate || 0, gross: grossAmt, src, quotedAt: it.quotedAt || null });
  }
  const sub = lines.reduce((s, l) => s + l.gross, 0);
  // ----- discount -----
  let discount = 0; const d = body.discount || {};
  if (d.value) {
    const type = v.oneOf(d.type, 'Discount type', ['AMT', 'PCT'], 'AMT');
    discount = type === 'PCT' ? M.divRound(sub * v.int(d.value, 'Discount %', { min: 0, max: 10000 }), 10000) : v.int(d.value, 'Discount', { min: 0, max: sub });
  }
  if (discount > sub) throw new BadRequest('Discount cannot exceed bill amount');
  const discBp = sub ? Math.ceil((discount * 10000) / sub) : 0;
  if (discount) {
    const myLimit = can(req.user.role, P.DISCOUNT) ? conf.discountLimits[req.user.role] || 0 : 0;
    if (strict && discBp > myLimit) {
      const a = auth.checkApproval(approvals.discount, 'discount', discBp);
      if (!a) throw new ApprovalRequired(`Discount ${(discBp / 100).toFixed(2)}% is above your limit ${(myLimit / 100).toFixed(2)}%. Manager approval required.`, 'discount', { value: discBp });
      approvedBy.discount = a;
    }
  }
  const lineDisc = M.allocate(discount, lines.map((l) => l.gross));
  let tax = 0, taxable = 0, linesTotal = 0;
  lines.forEach((l, k) => {
    l.discount = lineDisc[k];
    const net = l.gross - l.discount;
    const tx = M.lineTax(net, l.taxRate, conf.billing.priceIncludesTax);
    l.taxable = tx.taxable; l.taxAmount = tx.tax; l.amount = tx.total;
    tax += tx.tax; taxable += tx.taxable; linesTotal += tx.total;
  });
  const total = M.roundTo(linesTotal, conf.billing.roundStep);
  return { lines, sub, discount, discBp, taxable, tax, roundOff: total - linesTotal, total, approvedBy, notes };
}

function payments(body, total, conf) {
  const allowed = conf && Array.isArray(conf.billing.paymentModes) && conf.billing.paymentModes.length ? conf.billing.paymentModes : PAY_MODES;
  let list = Array.isArray(body.payments) && body.payments.length ? body.payments : [{ mode: 'CASH', amount: total }];
  list = list.map((p, i) => ({ mode: v.oneOf(p.mode, `Payment ${i + 1} mode`, PAY_MODES), amount: v.int(p.amount, `Payment ${i + 1} amount`, { min: 0, max: 1e12 }), ref: v.str(p.ref, 'Payment reference', { max: 60 }) })).filter((p) => p.amount > 0 || total === 0);
  const off = list.find((p) => !allowed.includes(p.mode));
  if (off) throw new BadRequest(`Payment by ${off.mode} is switched off in this shop`);
  const sum = list.reduce((s, p) => s + p.amount, 0);
  const tendered = body.tendered == null || body.tendered === '' ? null : v.int(body.tendered, 'Cash received', { min: 0, max: 1e12 });
  const cash = list.filter((p) => p.mode === 'CASH').reduce((s, p) => s + p.amount, 0);
  if (sum !== total) throw new BadRequest(`Payments ₹${M.rupees(sum)} do not match bill total ₹${M.rupees(total)}`);
  if (tendered != null && tendered < cash) throw new BadRequest('Cash received is less than the cash amount');
  const modes = [...new Set(list.map((p) => p.mode))];
  return { list, tendered, change: tendered != null ? tendered - cash : 0, mode: modes.length === 1 ? modes[0] : 'MIXED', credit: list.filter((p) => p.mode === 'CREDIT').reduce((s, p) => s + p.amount, 0) };
}

async function nextNumber(t, term, conf) {
  const fy = financialYear();
  const series = conf.billing.numbering === 'GLOBAL' ? 'ALL' : (term.series || term.code);
  const s = await t.settings.findOneAndUpdate({ _id: `seq-${series}-${fy}` }, { $inc: { v: 1 } }, { upsert: true });
  const n = String(s.v).padStart(6, '0');
  return { no: series === 'ALL' ? `${conf.billing.invoicePrefix}/${fy}/${n}` : `${conf.billing.invoicePrefix}/${fy}/${series}-${n}`, seq: s.v, series, fy };
}

async function complete(req, body) {
  if (!req.terminal) throw new Forbidden('Billing is only allowed from a registered counter PC');
  const idemKey = v.str(body.idemKey, 'Request id', { required: true, min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
  const dupe = await db.c.bills.findOne({ idemKey });
  if (dupe) return { bill: dupe, duplicate: true };           // retry after network drop -> same invoice, no double bill
  const conf = await settings.get();
  const pr = await price(req, body, conf);
  const pay = payments(body, pr.total, conf);
  // ----- customer -----
  let cust = null; const cin = body.customer || {};
  if (body.customerId) {
    cust = await db.c.customers.findOne({ _id: v.id(body.customerId, 'Customer') });
    if (!cust || cust.active === false) throw new BadRequest('Customer not found or inactive');
  }
  const walkIn = { name: v.str(cin.name, 'Customer name', { max: 80 }), mobile: v.mobile(cin.mobile), address: v.str(cin.address, 'Address', { max: 200 }) };
  // a mobile number typed on the Sale Entry screen identifies the customer: known number = that customer, new number = new customer
  if (!cust && walkIn.mobile) cust = await db.c.customers.findOne({ mobile: walkIn.mobile, active: { $ne: false } });
  // Sale Entry header fields: a label and a free note. They never change rates or totals.
  const saleMode = v.oneOf(body.saleMode, 'Sale mode', SALE_MODES, 'RETAIL'), remarks = v.str(body.remarks, 'Remarks', { max: 200 });
  if (pay.credit) {
    if (!cust) throw new BadRequest('Credit sale needs a registered customer (F3 to select)');
    if (!cust.creditAllowed) throw new BadRequest(`${cust.name} is not allowed credit`);
    const after = (cust.balance || 0) + pay.credit;
    if (cust.creditLimit && after > cust.creditLimit) {
      const msg = `Customer credit limit exceeded: outstanding would be ₹${M.rupees(after)} (limit ₹${M.rupees(cust.creditLimit)})`;
      if (conf.billing.creditPolicy === 'BLOCK' && conf.billing.operatorApprovals) {
        const a = auth.checkApproval((body.approvals || {}).credit_limit, 'credit_limit');
        if (!a) throw new ApprovalRequired(msg, 'credit_limit');
        pr.approvedBy.credit_limit = a;
      } else pr.notes.push(msg);
    }
  }
  const term = req.terminal;
  const shift = await db.c.cash_sessions.findOne({ terminalId: term._id, userId: req.user.id, status: 'OPEN' });
  try {
    const bill = await tx(async (t) => {
      const num = await nextNumber(t, term, conf);
      const now = new Date();
      if (cust || walkIn.mobile) cust = await customers.saveFromBill(t, req, cust, walkIn); // store new customer / changed name, address with the bill
      const b = await t.bills.insert({
        no: num.no, seq: num.seq, series: num.series, fy: num.fy, counter: term.series || term.code, terminalId: term._id, terminalCode: term.code,
        date: businessDate(now), at: now.toISOString(), idemKey,
        customerId: cust ? cust._id : null, customer: cust ? cust.name : walkIn.name, customerPhone: cust ? cust.mobile : walkIn.mobile,
        customerAddress: cust ? cust.address : walkIn.address, customerGstin: cust ? cust.gstin || '' : '', saleMode, remarks,
        items: pr.lines, sub: pr.sub, discount: pr.discount, discountBp: pr.discBp, taxable: pr.taxable, tax: pr.tax, roundOff: pr.roundOff, total: pr.total,
        payments: pay.list, mode: pay.mode, tendered: pay.tendered, change: pay.change, creditAmount: pay.credit,
        status: 'COMPLETED', returnedAmount: 0, by: req.user.username, operatorName: req.user.name, cashSessionId: shift ? shift._id : null,
        approvals: pr.approvedBy, printCount: 0, reprints: [], heldId: body.heldId || null,
      });
      for (const l of pr.lines) await inventory.move(t, { productId: l.productId, qty: -l.qty, type: 'SALE', ref: b.no, refId: b._id, by: req.user.username, terminal: term.code });
      if (cust) {
        await customers.post(t, cust._id, { type: 'SALE', debit: pr.total, ref: b.no, refId: b._id, by: req.user.username });
        const paid = pr.total - pay.credit;
        if (paid) await customers.post(t, cust._id, { type: 'PAYMENT', credit: paid, ref: `${b.no} ${pay.mode}`, refId: b._id, by: req.user.username });
      }
      if (body.heldId) await t.held_bills.remove({ _id: String(body.heldId) });
      await audit(req, 'BILL_COMPLETED', { entity: 'bill', entityId: b._id, new: { no: b.no, total: b.total }, detail: Object.keys(pr.approvedBy).length ? 'approvals ' + JSON.stringify(pr.approvedBy) : '' }, t);
      for (const [action, by] of Object.entries(pr.approvedBy)) await audit(req, 'OVERRIDE_' + action.toUpperCase(), { entity: 'bill', entityId: b._id, detail: b.no, approvedBy: by }, t);
      for (const l of pr.lines) {
        if (l.src === 'MANUAL') await audit(req, 'MANUAL_WEIGHT', { entity: 'bill', entityId: b._id, detail: `${b.no} ${l.name} ${l.qty}`, approvedBy: pr.approvedBy.weight_manual || '' }, t);
        if (l.rateSrc === 'MANUAL') await audit(req, 'MANUAL_RATE', { entity: 'bill', entityId: b._id, detail: `${b.no} ${l.name}`, new: l.rate, approvedBy: pr.approvedBy.rate_override || '' }, t);
      }
      return b;
    }, 'bill-complete');
    rt.emit('bill:completed', summary(bill), 'managers');
    rt.emit('inventory:updated', { productIds: bill.items.map((l) => l.productId) });
    return { bill, notes: pr.notes };
  } catch (e) {
    if (e.duplicateKey) { const d = await db.c.bills.findOne({ idemKey }); if (d) return { bill: d, duplicate: true }; }
    throw e;
  }
}
const summary = (b) => ({ _id: b._id, no: b.no, at: b.at, date: b.date, terminalCode: b.terminalCode, counter: b.counter, by: b.by, customer: b.customer, items: b.items.length, total: b.total, mode: b.mode, status: b.status });

function canSee(req, b) {
  if (can(req.user.role, P.BILL_VIEW_ALL)) return true;
  return can(req.user.role, P.BILL_VIEW_OWN) && b.by === req.user.username;
}
async function get(req, id) {
  const b = await db.c.bills.findOne({ _id: id });
  if (!b || !canSee(req, b)) throw new NotFound('Bill not found');
  if (!can(req.user.role, P.REPORT_PROFIT)) b.items = b.items.map(({ purchaseRate, ...l }) => l);
  return b;
}
async function list(req, q) {
  const f = {};
  if (q.date) f.date = q.date; else if (q.from || q.to) { f.date = {}; if (q.from) f.date.$gte = q.from; if (q.to) f.date.$lte = q.to; }
  if (q.status) f.status = v.oneOf(q.status, 'Status', ['COMPLETED', 'CANCELLED', 'RETURNED', 'PARTIALLY_RETURNED']);
  if (q.terminal) f.terminalCode = v.str(q.terminal, 'Terminal', { max: 20 });
  if (q.customerId) f.customerId = v.id(q.customerId);
  if (q.mode) f.mode = v.oneOf(q.mode, 'Mode', [...PAY_MODES, 'MIXED']);
  if (q.no) f.no = new RegExp(v.rx(v.str(q.no, 'Bill no', { max: 40 })), 'i');
  if (!can(req.user.role, P.BILL_VIEW_ALL)) f.by = req.user.username; else if (q.by) f.by = v.str(q.by, 'Operator', { max: 40 });
  const limit = v.int(q.limit, 'limit', { min: 1, max: 500, def: 100 }), skip = v.int(q.skip, 'skip', { min: 0, max: 1e7, def: 0 });
  const rows = await db.c.bills.find(f, { sort: { at: -1 }, limit, skip });
  const profit = can(req.user.role, P.REPORT_PROFIT);
  return rows.map(({ approvals, ...b }) => (profit ? b : { ...b, items: b.items.map(({ purchaseRate, ...l }) => l) }));
}
/** void a completed bill: reverses stock, ledger; original stays, marked CANCELLED */
async function cancel(req, id, body) {
  const reason = v.str(body.reason, 'Reason', { required: true, min: 3, max: 200 });
  const approver = auth.needs(req, P.BILL_CANCEL, 'bill_cancel', body.approval, null, 'Cancelling a bill needs manager approval');
  const b = await tx(async (t) => {
    const b = await t.bills.findOne({ _id: id });
    if (!b) throw new NotFound('Bill not found');
    if (b.status !== 'COMPLETED') throw new Conflict(`Bill is ${b.status}; only completed bills without returns can be cancelled`);
    for (const l of b.items) await inventory.move(t, { productId: l.productId, qty: l.qty, type: 'SALE_CANCEL', ref: b.no, refId: b._id, by: req.user.username, reason });
    if (b.customerId) {
      const paid = b.total - (b.creditAmount || 0);
      await customers.post(t, b.customerId, { type: 'SALE_CANCEL', credit: b.total, ref: b.no, refId: b._id, by: req.user.username, note: reason });
      if (paid) await customers.post(t, b.customerId, { type: 'REFUND', debit: paid, ref: b.no, refId: b._id, by: req.user.username, note: 'payment reversed' });
    }
    const now = new Date().toISOString();
    await t.bills.update({ _id: id }, { $set: { status: 'CANCELLED', cancel: { by: req.user.username, approvedBy: approver, at: now, reason, date: businessDate() }, cancelReason: reason } });
    await audit(req, 'BILL_CANCELLED', { entity: 'bill', entityId: id, old: 'COMPLETED', new: 'CANCELLED', reason, detail: b.no, approvedBy: approver !== req.user.username ? approver : '' }, t);
    return t.bills.findOne({ _id: id });
  }, 'bill-cancel');
  rt.emit('bill:cancelled', summary(b), 'managers');
  rt.emit('inventory:updated', { productIds: b.items.map((l) => l.productId) });
  return b;
}
/** full / partial return. items: [{line, qty}] */
async function createReturn(req, id, body) {
  const reason = v.str(body.reason, 'Reason', { required: true, min: 3, max: 200 });
  const refundMode = v.oneOf(body.refundMode, 'Refund mode', ['CASH', 'UPI', 'CARD', 'BANK', 'CREDIT_NOTE'], 'CASH');
  const approver = auth.needs(req, P.BILL_RETURN, 'bill_return', body.approval, null, 'Returns need manager approval');
  const idemKey = body.idemKey ? v.str(body.idemKey, 'Request id', { max: 64, pattern: /^[A-Za-z0-9_-]+$/ }) : null;
  if (idemKey) { const d = await db.c.returns.findOne({ idemKey }); if (d) return d; }
  const r = await tx(async (t) => {
    const b = await t.bills.findOne({ _id: id });
    if (!b) throw new NotFound('Bill not found');
    if (!['COMPLETED', 'PARTIALLY_RETURNED'].includes(b.status)) throw new Conflict(`Bill is ${b.status}`);
    if (refundMode === 'CREDIT_NOTE' && !b.customerId) throw new BadRequest('Credit note needs a registered customer on the bill');
    const prev = await t.returns.find({ billId: id });
    const done = {}; prev.forEach((r) => r.items.forEach((x) => { done[x.line] = (done[x.line] || 0) + x.qty; }));
    const want = Array.isArray(body.items) ? body.items : [];
    if (!want.length) throw new BadRequest('Select items to return');
    const items = []; let amount = 0;
    for (const w of want) {
      const li = v.int(w.line, 'Line', { min: 0, max: b.items.length - 1 });
      const l = b.items[li];
      const qty = v.int(w.qty, `${l.name} return quantity`, { min: 1, max: l.qty - (done[li] || 0) });
      const amt = qty === l.qty ? l.amount : M.divRound(l.amount * qty, l.qty);
      const tax = qty === l.qty ? l.taxAmount : M.divRound(l.taxAmount * qty, l.qty);
      items.push({ line: li, productId: l.productId, name: l.name, unit: l.unit, qty, rate: l.rate, amount: amt, taxAmount: tax });
      amount += amt;
      await inventory.move(t, { productId: l.productId, qty, type: 'SALE_RETURN', ref: b.no, refId: b._id, by: req.user.username, reason });
    }
    const totalReturnedQty = b.items.every((l, i) => (done[i] || 0) + (items.find((x) => x.line === i) || { qty: 0 }).qty === l.qty);
    const ret = await t.returns.insert({ billId: id, billNo: b.no, at: new Date().toISOString(), date: businessDate(), items, amount, refundMode, reason, by: req.user.username, approvedBy: approver, terminalId: req.terminal ? req.terminal._id : null, terminalCode: req.terminal ? req.terminal.code : '', customerId: b.customerId || null, idemKey });
    if (b.customerId) {
      await customers.post(t, b.customerId, { type: 'RETURN', credit: amount, ref: b.no, refId: ret._id, by: req.user.username, note: reason });
      if (refundMode !== 'CREDIT_NOTE') await customers.post(t, b.customerId, { type: 'REFUND', debit: amount, ref: `${b.no} ${refundMode}`, refId: ret._id, by: req.user.username });
    }
    await t.bills.update({ _id: id }, { $set: { status: totalReturnedQty ? 'RETURNED' : 'PARTIALLY_RETURNED' }, $inc: { returnedAmount: amount } });
    await audit(req, 'BILL_RETURN', { entity: 'bill', entityId: id, new: { amount, refundMode, items: items.length }, reason, detail: b.no, approvedBy: approver !== req.user.username ? approver : '' }, t);
    return ret;
  }, 'bill-return');
  rt.emit('bill:returned', { billId: id, billNo: r.billNo, amount: r.amount }, 'managers');
  rt.emit('inventory:updated', { productIds: r.items.map((x) => x.productId) });
  return r;
}
/** record a print; reprints are permission-controlled and logged */
async function printed(req, id, body) {
  const b = await db.c.bills.findOne({ _id: id });
  if (!b || !canSee(req, b)) throw new NotFound('Bill not found');
  const conf = await settings.get();
  if ((b.printCount || 0) === 0 && !body.reprint) { await db.c.bills.update({ _id: id }, { $inc: { printCount: 1 } }); return { duplicate: false }; }
  const reason = v.str(body.reason, 'Reprint reason', { max: 120, required: conf.billing.reprintReasonRequired });
  let approver = req.user.username;
  if (!can(req.user.role, P.BILL_REPRINT) || (req.user.role === 'OPERATOR' && !conf.billing.operatorCanReprint)) approver = auth.needs({ user: { role: 'NONE' } }, P.BILL_REPRINT, 'reprint', body.approval, null, 'Reprint needs manager approval');
  const entry = { by: req.user.username, approvedBy: approver, terminal: req.terminal ? req.terminal.code : '', at: new Date().toISOString(), reason };
  await db.c.bills.update({ _id: id }, { $inc: { printCount: 1 }, $push: { reprints: entry } });
  await audit(req, 'REPRINT', { entity: 'bill', entityId: id, detail: b.no, reason, approvedBy: approver !== req.user.username ? approver : '' });
  return { duplicate: true };
}
/* ---------- hold / resume ---------- */
async function hold(req, body) {
  if (!req.terminal) throw new Forbidden('Hold is only available on a counter PC');
  const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
  if (!items.length) throw new BadRequest('Nothing to hold');
  const clean = items.map((it) => ({ productId: v.id(it.productId), name: v.str(it.name, 'name', { max: 80 }), unit: v.str(it.unit, 'unit', { max: 10 }), qty: v.int(it.qty, 'qty', { min: 1, max: 1e9 }),
    rate: v.int(it.rate, 'rate', { min: 0, max: 1e10 }), tare: v.int(it.tare, 'tare', { min: 0, max: 1e9, def: 0 }), src: v.str(it.src, 'src', { max: 10 }), quotedAt: v.str(it.quotedAt, 'quotedAt', { max: 40 }), reading: it.reading && typeof it.reading === 'object' ? { grams: +it.reading.grams, at: String(it.reading.at), terminal: String(it.reading.terminal), mock: !!it.reading.mock, sig: String(it.reading.sig) } : null, amount: v.int(it.amount, 'amount', { min: 0, max: 1e12, def: 0 }) }));
  const h = await db.c.held_bills.insert({ terminalId: req.terminal._id, terminalCode: req.terminal.code, by: req.user.username, at: new Date().toISOString(),
    customerId: body.customerId ? v.id(body.customerId) : null, customer: body.customer && typeof body.customer === 'object' ? { name: v.str(body.customer.name, 'Customer', { max: 80 }), mobile: v.str(body.customer.mobile, 'Mobile', { max: 15 }), address: v.str(body.customer.address, 'Address', { max: 200 }) } : {},
    items: clean, discount: body.discount && typeof body.discount === 'object' ? { type: body.discount.type === 'PCT' ? 'PCT' : 'AMT', value: v.int(body.discount.value, 'Discount', { min: 0, max: 1e12, def: 0 }) } : null,
    total: clean.reduce((s, x) => s + x.amount, 0), note: v.str(body.note, 'Note', { max: 80 }), saleMode: v.oneOf(body.saleMode, 'Sale mode', SALE_MODES, 'RETAIL') });
  await audit(req, 'BILL_HELD', { entity: 'held', entityId: h._id, detail: `${clean.length} items` });
  rt.emit('bill:held', { terminalCode: h.terminalCode, count: 1 }, 'managers');
  return h;
}
async function heldList(req) {
  const conf = await settings.get();
  const any = can(req.user.role, P.BILL_RESUME_ANY) || conf.billing.holdCrossTerminal;
  const q = any ? {} : { terminalId: req.terminal ? req.terminal._id : '-' };
  return db.c.held_bills.find(q, { sort: { at: -1 }, limit: 100 });
}
async function resume(req, id) {
  const h = await db.c.held_bills.findOne({ _id: id });
  if (!h) throw new NotFound('Held bill not found (maybe already resumed)');
  const conf = await settings.get();
  if ((!req.terminal || h.terminalId !== req.terminal._id) && !can(req.user.role, P.BILL_RESUME_ANY) && !conf.billing.holdCrossTerminal) throw new Forbidden('This bill was held on another counter');
  const n = await db.c.held_bills.remove({ _id: id });
  if (!n) throw new NotFound('Held bill was already resumed');
  await audit(req, 'BILL_RESUMED', { entity: 'held', entityId: id, detail: h.terminalCode });
  return h;
}
/** the number the next bill of this counter will get (shown on the Sale Entry screen; the real number is taken when the bill is saved) */
async function peekNumber(req) {
  if (!req.terminal) return { no: '' };
  const conf = await settings.get(), fy = financialYear();
  const series = conf.billing.numbering === 'GLOBAL' ? 'ALL' : (req.terminal.series || req.terminal.code);
  const s = await db.c.settings.findOne({ _id: `seq-${series}-${fy}` });
  const n = String((s ? s.v : 0) + 1).padStart(6, '0');
  return { no: series === 'ALL' ? `${conf.billing.invoicePrefix}/${fy}/${n}` : `${conf.billing.invoicePrefix}/${fy}/${series}-${n}` };
}
module.exports = { peekNumber, price, payments, complete, get, list, cancel, createReturn, printed, hold, heldList, resume, summary, PAY_MODES };
