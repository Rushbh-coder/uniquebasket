'use strict';
/** Shop-server API (runs on the manager/server PC). All input validated in services; all money in paise. */
const express = require('express');
const { P } = require('../auth/rbac');
const auth = require('../auth');
const { requireAuth: A } = auth;
const products = require('../services/products');
const customers = require('../services/customers');
const invoices = require('../services/invoices');
const purchases = require('../services/purchases');
const cash = require('../services/cash');
const terminals = require('../services/terminals');
const users = require('../services/users');
const reports = require('../services/reports');
const backup = require('../services/backup');
const settings = require('../services/settings');
const rt = require('../realtime');
const { db } = require('../db');
const v = require('../lib/validate');
const cfg = require('../config');
const { audit } = require('../services/audit');
const { BadRequest, Unauthorized } = require('../lib/errors');

const r = express.Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((x) => { if (!res.headersSent) res.json(x === undefined ? { ok: true } : x); }).catch(next);

/* ---------- public ---------- */
r.get('/health', (req, res) => res.json({ ok: true, mode: cfg.mode, db: db.kind, version: cfg.version, time: new Date().toISOString() }));
r.post('/login', h((req) => auth.login(req, req.body.username, req.body.password)));
r.post('/terminals/enrol', h((req) => terminals.enrol(req.body, req.ip)));
r.post('/terminals/heartbeat', h((req) => terminals.heartbeat(req, req.body)));
r.get('/terminal', h(async (req) => (req.terminal ? { code: req.terminal.code, name: req.terminal.name, series: req.terminal.series, print: req.terminal.print || {}, local: !!req.terminal.local } : null)));

/* ---------- session ---------- */
r.get('/me', A(), h(async (req) => auth.publicUser(await db.c.users.findOne({ _id: req.user.id }))));
r.post('/logout', A(), h((req) => auth.logout(req)));
r.post('/approve', A(), h((req) => auth.approve(req, { username: req.body.username, secret: req.body.secret, action: v.str(req.body.action, 'Action', { required: true, max: 30 }), value: req.body.value == null ? null : v.int(req.body.value, 'value', { min: 0, max: 1e12 }) })));
r.post('/me/password', A(), h((req) => users.changeOwn(req, req.body)));
r.get('/config', A(), h(async () => settings.publicView(await settings.get())));
r.post('/events/ticket', A(), h(async (req) => ({ ticket: rt.issueTicket({ id: req.user.id, role: req.user.role, username: req.user.username }, req.terminal ? req.terminal._id : null) })));
r.get('/events', (req, res) => {
  const t = rt.takeTicket(String(req.query.ticket || ''));
  if (!t) return res.status(401).json({ error: 'Please login' });
  const { can } = require('../auth/rbac');
  rt.attach(req, res, { userId: t.user.id, terminalId: t.terminal, manager: can(t.user.role, P.DASHBOARD) });
});

/* ---------- products & prices ---------- */
r.get('/products', A(P.PRODUCT_VIEW), h(async (req) => {
  const full = req.query.all === '1' && require('../auth/rbac').can(req.user.role, P.PRODUCT_EDIT);
  const list = await products.list({ all: full });
  return full ? list : list.map(products.posView);
}));
r.post('/products', A(P.PRODUCT_EDIT), h((req) => products.create(req, req.body)));
r.put('/products/:id', A(P.PRODUCT_EDIT), h((req) => products.update(req, v.id(req.params.id), req.body)));
r.post('/products/:id/price', A(P.PRICE_EDIT), h((req) => products.changePrice(req, v.id(req.params.id), req.body)));
r.get('/products/:id/prices', A(P.PRODUCT_VIEW), h((req) => products.history(v.id(req.params.id))));
r.get('/prices/history', A(P.PRODUCT_VIEW), h(() => products.history(null, { limit: 500 }))); // operators see the same list as managers
r.get('/prices/scheduled', A(P.PRICE_EDIT), h(() => db.c.price_schedule.find({ status: 'PENDING' }, { sort: { effectiveAt: 1 } })));
r.delete('/prices/scheduled/:id', A(P.PRICE_EDIT), h((req) => products.cancelSchedule(req, v.id(req.params.id))));
r.get('/categories', A(P.PRODUCT_VIEW), h(async () => [...new Set((await db.c.products.find({}, { projection: { category: 1 } })).map((p) => p.category).filter(Boolean))].sort()));

/* ---------- customers ---------- */
r.get('/customers', A(P.CUSTOMER_VIEW), h((req) => customers.search(req.query.q, { limit: Math.min(+req.query.limit || 30, 200), all: req.query.all === '1' })));
r.get('/customers/:id', A(P.CUSTOMER_VIEW), h(async (req) => { const c = await db.c.customers.findOne({ _id: v.id(req.params.id) }); if (!c) throw new BadRequest('Customer not found'); return c; }));
r.post('/customers', A(P.CUSTOMER_CREATE), h((req) => customers.create(req, req.body)));
r.put('/customers/:id', A(P.CUSTOMER_EDIT), h((req) => customers.update(req, v.id(req.params.id), req.body)));
r.post('/customers/:id/payments', A(P.CUSTOMER_PAYMENT), h((req) => customers.receivePayment(req, v.id(req.params.id), req.body)));
r.get('/customers/:id/ledger', A(P.CUSTOMER_PAYMENT), h((req) => customers.ledger(v.id(req.params.id), { from: req.query.from, to: req.query.to })));

/* ---------- billing ---------- */
r.post('/bills/preview', A(P.BILL_CREATE), h(async (req) => { const x = await invoices.price(req, req.body, await settings.get()); x.lines.forEach((l) => delete l.purchaseRate); return x; }));
r.post('/bills', A(P.BILL_CREATE), h((req) => invoices.complete(req, req.body)));
r.get('/bills', A(), h((req) => {
  const { can } = require('../auth/rbac');
  if (!can(req.user.role, P.BILL_VIEW_ALL) && !can(req.user.role, P.BILL_VIEW_OWN)) throw new BadRequest('Not permitted');
  return invoices.list(req, req.query);
}));
r.get('/bills/next-number', A(P.BILL_CREATE), h((req) => invoices.peekNumber(req)));
r.get('/bills/:id', A(), h((req) => invoices.get(req, v.id(req.params.id))));
r.post('/bills/:id/cancel', A(), h((req) => invoices.cancel(req, v.id(req.params.id), req.body)));
r.post('/bills/:id/returns', A(), h((req) => invoices.createReturn(req, v.id(req.params.id), req.body)));
r.get('/bills/:id/returns', A(), h(async (req) => { await invoices.get(req, v.id(req.params.id)); return db.c.returns.find({ billId: req.params.id }, { sort: { at: 1 } }); }));
r.post('/bills/:id/printed', A(), h((req) => invoices.printed(req, v.id(req.params.id), req.body)));
r.get('/held', A(P.BILL_HOLD), h((req) => invoices.heldList(req)));
r.post('/held', A(P.BILL_HOLD), h((req) => invoices.hold(req, req.body)));
r.post('/held/:id/resume', A(P.BILL_HOLD), h((req) => invoices.resume(req, v.id(req.params.id))));

/* ---------- cash shift ---------- */
r.get('/shift', A(P.CASH_SESSION), h(async (req) => { const s = await cash.current(req); return s ? { ...s, ...(await cash.expected(s)) } : null; }));
r.post('/shift/open', A(P.CASH_SESSION), h((req) => cash.open(req, req.body)));
r.post('/shift/close', A(P.CASH_SESSION), h((req) => cash.close(req, req.body)));
r.get('/shifts', A(P.CASH_REVIEW), h((req) => cash.list(req.query)));

/* ---------- suppliers, purchases, stock ---------- */
r.get('/suppliers', A(P.PURCHASE_EDIT), h(() => db.c.suppliers.find({}, { sort: { name: 1 } })));
r.post('/suppliers', A(P.SUPPLIER_EDIT), h((req) => purchases.createSupplier(req, req.body)));
r.put('/suppliers/:id', A(P.SUPPLIER_EDIT), h((req) => purchases.updateSupplier(req, v.id(req.params.id), req.body)));
r.post('/suppliers/:id/payments', A(P.SUPPLIER_EDIT), h((req) => purchases.paySupplier(req, v.id(req.params.id), req.body)));
r.get('/suppliers/:id/ledger', A(P.SUPPLIER_EDIT), h((req) => db.c.supplier_ledger.find({ supplierId: v.id(req.params.id) }, { sort: { at: 1 } })));
r.get('/purchases', A(P.PURCHASE_EDIT), h((req) => db.c.purchases.find(req.query.from ? { date: { $gte: req.query.from, $lte: req.query.to || '9999' } } : {}, { sort: { at: -1 }, limit: 200 })));
r.post('/purchases', A(P.PURCHASE_EDIT), h((req) => purchases.createPurchase(req, req.body)));
r.post('/stock/adjust', A(P.STOCK_ADJUST), h((req) => purchases.adjust(req, req.body, 'ADJUST')));
r.post('/stock/wastage', A(P.WASTAGE), h((req) => purchases.adjust(req, req.body, 'WASTAGE')));
r.get('/stock/ledger/:productId', A(P.STOCK_VIEW), h((req) => purchases.stockLedger(req.params.productId, req.query)));

/* ---------- manager ---------- */
r.get('/dashboard', A(P.DASHBOARD), h(() => reports.dashboard()));
r.get('/reports/:name', A(P.REPORT_SALES), h(async (req, res) => {
  const rows = await reports.run(req, req.params.name, req.query);
  if (req.query.format === 'csv') { res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', `attachment; filename="${req.params.name}-${req.query.from || ''}.csv"`); res.send('﻿' + reports.csv(rows)); return; }
  return rows;
}));
r.get('/audit', A(P.AUDIT_VIEW), h(async (req) => {
  const q = {}; if (req.query.action) q.action = v.str(req.query.action, 'action', { max: 40 }); if (req.query.user) q.user = v.str(req.query.user, 'user', { max: 40 });
  if (req.query.from) q.at = { $gte: req.query.from, $lte: (req.query.to || '9999') + '~' };
  return db.c.audit.find(q, { sort: { at: -1 }, limit: Math.min(+req.query.limit || 200, 1000) });
}));
r.get('/users', A(P.USER_MANAGE), h(() => users.list()));
r.post('/users', A(P.USER_MANAGE), h((req) => users.create(req, req.body)));
r.put('/users/:id', A(P.USER_MANAGE), h((req) => users.update(req, v.id(req.params.id), req.body)));
r.get('/sessions', A(P.USER_MANAGE), h(() => db.c.sessions.find({}, { sort: { loginAt: -1 }, limit: 200 })));
r.get('/terminals', A(P.DASHBOARD), h(() => terminals.list()));
r.post('/terminals', A(P.TERMINAL_MANAGE), h((req) => terminals.create(req, req.body)));
r.put('/terminals/:id', A(P.TERMINAL_MANAGE), h((req) => terminals.update(req, v.id(req.params.id), req.body)));
r.post('/terminals/:id/enrol-code', A(P.TERMINAL_MANAGE), h((req) => terminals.newEnrolCode(req, v.id(req.params.id))));
r.get('/settings', A(P.SETTINGS), h(() => settings.get()));
r.put('/settings', A(P.SETTINGS), h(async (req) => {
  const before = await settings.get();
  const patch = sanitizeSettings(req.body);
  const after = await settings.save(patch);
  await audit(req, 'SETTINGS_CHANGED', { entity: 'settings', old: pick(before, patch), new: pick(after, patch) });
  rt.emit('settings:updated', settings.publicView(after));
  return after;
}));
r.get('/backups', A(P.BACKUP), h(() => backup.list()));
r.post('/backups', A(P.BACKUP), h(async (req) => { const b = await backup.backupNow(req.user.username); await audit(req, 'BACKUP_CREATED', { detail: b.file }); return b; }));
r.post('/backups/restore', A(P.BACKUP), h(async (req) => {
  const { can } = require('../auth/rbac');
  if (!can(req.user.role, P.SETTINGS) || !['OWNER', 'SUPER_ADMIN', 'MANAGER'].includes(req.user.role)) throw new BadRequest('Not permitted');
  if (req.body.confirm !== 'RESTORE') throw new BadRequest('Type RESTORE to confirm');
  const ok = await auth.verifyUser(req.user.username, req.body.password); if (!ok) throw new Unauthorized('Password is wrong');
  const x = await backup.restore(req, req.body.file); rt.emit('data:restored', {}); return x;
}));

const pick = (o, p) => Object.fromEntries(Object.keys(p).map((k) => [k, o[k]]));
function sanitizeSettings(b) {
  const out = {};
  const S = (o, k, opt) => v.str(o[k], k, opt);
  if (b.shop) out.shop = { name: S(b.shop, 'name', { required: true, max: 60 }), tagline: S(b.shop, 'tagline', { max: 80 }), address: S(b.shop, 'address', { max: 200 }), city: S(b.shop, 'city', { max: 40 }), phone: S(b.shop, 'phone', { max: 40 }), gstin: v.gstin(b.shop.gstin), state: S(b.shop, 'state', { max: 40 }), footer: S(b.shop, 'footer', { max: 120 }) };
  if (b.billing) {
    const x = b.billing, o = {};
    if (x.invoicePrefix != null) o.invoicePrefix = v.str(x.invoicePrefix, 'Invoice prefix', { required: true, max: 6, pattern: /^[A-Z0-9]+$/ });
    if (x.numbering != null) o.numbering = v.oneOf(x.numbering, 'Numbering', ['COUNTER', 'GLOBAL']);
    if (x.roundStep != null) o.roundStep = v.oneOf(+x.roundStep, 'Rounding', [1, 10, 50, 100]);
    if (x.creditPolicy != null) o.creditPolicy = v.oneOf(x.creditPolicy, 'Credit policy', ['BLOCK', 'WARN']);
    for (const k of ['priceIncludesTax', 'allowNegativeStock', 'operatorApprovals', 'manualWeightNeedsApproval', 'operatorCanReprint', 'reprintReasonRequired', 'holdCrossTerminal', 'allowMockScale', 'whatsappOnSave']) if (x[k] != null) o[k] = v.bool(x[k]);
    if (x.paymentModes != null) {
      if (!Array.isArray(x.paymentModes)) throw new BadRequest('Payment modes must be a list');
      o.paymentModes = invoices.PAY_MODES.filter((m) => x.paymentModes.includes(m)); // keeps the standard order, drops unknown names
      if (!o.paymentModes.length) throw new BadRequest('Keep at least one payment mode');
    }
    out.billing = o;
  }
  if (b.discountLimits) { out.discountLimits = {}; for (const [k, x] of Object.entries(b.discountLimits)) if (require('../auth/rbac').ROLES[k]) out.discountLimits[k] = v.int(x, `Discount limit ${k}`, { min: 0, max: 10000 }); }
  if (b.print) out.print = { paper: v.oneOf(b.print.paper, 'Paper', ['58mm', '80mm', 'A4'], '80mm'), copies: v.int(b.print.copies, 'Copies', { min: 1, max: 5, def: 1 }), silent: v.bool(b.print.silent, true), showGstBreakup: v.bool(b.print.showGstBreakup, true), saveCopy: v.oneOf(b.print.saveCopy, 'Save bill copy', ['OFF', 'PRINT_AND_SAVE', 'SAVE_ONLY'], 'OFF') };
  if (b.shortcuts) { out.shortcuts = {}; for (const [k, x] of Object.entries(b.shortcuts)) out.shortcuts[v.str(k, 'action', { max: 30, pattern: /^[a-zA-Z]+$/ })] = v.str(x, 'key', { max: 20, pattern: /^[A-Za-z0-9+]+$/ }); }
  if (b.backup) out.backup = { dailyAt: v.str(b.backup.dailyAt, 'Backup time', { required: true, pattern: /^\d{2}:\d{2}$/ }), keepDays: v.int(b.backup.keepDays, 'Keep days', { min: 3, max: 365, def: 30 }) };
  return out;
}
module.exports = r;
