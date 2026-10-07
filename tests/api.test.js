'use strict';
/* End-to-end API tests against a real server instance (in-memory DB).
 * Run: npm test   (sandbox: NODE_PATH=tests/shims/node_modules node --test tests/)
 * TEST_DB=nedb runs the same suite on the built-in file database that an offline shop server uses (npm run test:offline). */
process.env.DB_MEMORY = process.env.TEST_DB === 'nedb' ? '' : '1'; process.env.MONGO_URI = '';
process.env.SEED_DEMO = '1'; process.env.APP_MODE = 'server'; process.env.NODE_ENV = 'test';
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'billtest-'));
const test = require('node:test'), assert = require('node:assert/strict');
const srv = require('../server');
const reading = require('../server/lib/reading');
let base, mgr, T = [];
const call = async (path, { method = 'GET', body, tok, key } = {}) => {
  const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(key ? { 'x-terminal-key': key } : {}) }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => null); return { s: r.status, j };
};
const login = async (u, p, key) => { const r = await call('/login', { method: 'POST', body: { username: u, password: p }, key }); assert.equal(r.s, 200, JSON.stringify(r.j)); return r.j.token; };
const idem = () => require('crypto').randomUUID().replace(/-/g, '');
let P = {};
test.before(async () => {
  const port = await srv.start(0, '127.0.0.1'); base = 'http://127.0.0.1:' + port;
  mgr = await login('manager', 'manager123');
  const ps = (await call('/products', { tok: mgr })).j; for (const p of ps) P[p.code] = p;
  for (let i = 1; i <= 4; i++) {
    const c = await call('/terminals', { method: 'POST', tok: mgr, body: { code: 'COUNTER-0' + i, name: 'Counter ' + i, series: 'C' + (i + 1) } });
    assert.equal(c.s, 200, JSON.stringify(c.j));
    const e = await call('/terminals/enrol', { method: 'POST', body: { enrolCode: c.j.enrolCode, machine: 'PC-0' + i } });
    assert.equal(e.s, 200); T.push({ ...e.j, tok: await login('operator' + i, 'operator123', e.j.terminalKey) });
  }
  // operatorApprovals is OFF by default (no manager PIN while billing); the approval tests below need it ON
  await call('/settings', { method: 'PUT', tok: mgr, body: { billing: { allowMockScale: true, operatorApprovals: true, paymentModes: ['CASH', 'UPI', 'CARD', 'BANK', 'CREDIT'] } } });
});
test.after(() => srv.stop());
// a reading signed exactly like the counter's scale service does
const scaleLine = (t, productId, grams, extra = {}) => ({ productId, qty: grams, reading: reading.sign(t.scaleSecret, { grams, at: new Date().toISOString(), terminal: t.code, mock: false }), ...extra });

test('4 operators bill simultaneously: unique numbers, correct stock', async () => {
  const before = (await call('/products', { tok: mgr })).j.find((p) => p.code === 'TOM').stock;
  const jobs = [];
  for (let n = 0; n < 10; n++) for (const t of T) jobs.push(call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [scaleLine(t, P.TOM._id, 1000)] } }));
  const res = await Promise.all(jobs);
  res.forEach((r) => assert.equal(r.s, 200, JSON.stringify(r.j)));
  const nos = res.map((r) => r.j.bill.no); assert.equal(new Set(nos).size, 40);
  for (let i = 0; i < 4; i++) assert.equal(nos.filter((x) => x.includes(`/C${i + 2}-`)).length, 10);
  const after = (await call('/products', { tok: mgr })).j.find((p) => p.code === 'TOM').stock;
  assert.equal(before - after, 40 * 1000);
  assert.equal(res[0].j.bill.items[0].src, 'SCALE');
  assert.equal(res[0].j.bill.total, 3000);   // 1.000 kg x ₹30
});
test('18.450 kg x ₹32 = ₹590.40 -> rounded ₹590, exact paise math', async () => {
  const t = T[0];
  await call(`/products/${P.TOM._id}/price`, { method: 'POST', tok: mgr, body: { rate: 3200 } });
  const r = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [scaleLine(t, P.TOM._id, 18450)], payments: [{ mode: 'CASH', amount: 59000 }], tendered: 100000 } });
  assert.equal(r.s, 200, JSON.stringify(r.j)); const b = r.j.bill;
  assert.equal(b.items[0].gross, 59040); assert.equal(b.roundOff, -40); assert.equal(b.total, 59000); assert.equal(b.change, 41000);
  await call(`/products/${P.TOM._id}/price`, { method: 'POST', tok: mgr, body: { rate: 3000 } });
});
test('price change: old bill unchanged, open-bill line keeps quoted rate, new line gets new rate', async () => {
  const t = T[1];
  const quotedAt = new Date().toISOString();
  const old = (await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [scaleLine(t, P.TOM._id, 1000)] } })).j.bill;
  assert.equal(old.items[0].rate, 3000);
  await new Promise((r) => setTimeout(r, 15));
  const ch = await call(`/products/${P.TOM._id}/price`, { method: 'POST', tok: mgr, body: { rate: 3400, reason: 'market' } });
  assert.equal(ch.s, 200); assert.equal(ch.j.product.rate, 3400);
  const again = (await call('/bills/' + old._id, { tok: mgr })).j; assert.equal(again.items[0].rate, 3000); assert.equal(again.total, 3000);
  const open = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [scaleLine(t, P.TOM._id, 1000, { rate: 3000, quotedAt }), scaleLine(t, P.TOM._id, 1000)] } });
  assert.equal(open.s, 200, JSON.stringify(open.j));
  assert.deepEqual(open.j.bill.items.map((l) => l.rate), [3000, 3400]); assert.equal(open.j.bill.items[0].rateSrc, 'QUOTED');
  // operator cannot invent a cheaper rate
  const cheat = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [scaleLine(t, P.TOM._id, 1000, { rate: 1000, quotedAt })] } });
  assert.equal(cheat.s, 403); assert.equal(cheat.j.code, 'APPROVAL_REQUIRED');
  const hist = (await call(`/products/${P.TOM._id}/prices`, { tok: mgr })).j; assert.ok(hist.some((h) => h.old === 3000 && h.rate === 3400 && h.by === 'manager'));
  // the all-products rate change list is the same for operator and manager; operator still cannot change a rate
  const allOp = await call('/prices/history', { key: t.terminalKey, tok: t.tok }), allMgr = await call('/prices/history', { tok: mgr });
  assert.equal(allOp.s, 200, JSON.stringify(allOp.j)); assert.deepEqual(allOp.j, allMgr.j);
  assert.ok(allOp.j.some((h) => h.productId === P.TOM._id && h.old === 3000 && h.rate === 3400));
  assert.equal((await call(`/products/${P.TOM._id}/price`, { method: 'POST', key: t.terminalKey, tok: t.tok, body: { rate: 100 } })).s, 403);
  await call(`/products/${P.TOM._id}/price`, { method: 'POST', tok: mgr, body: { rate: 3000 } });
});
test('sale mode and remarks are saved on the bill and never change the amount', async () => {
  const t = T[0];
  const plain = (await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [scaleLine(t, P.TOM._id, 1000)] } })).j.bill;
  assert.equal(plain.saleMode, 'RETAIL'); assert.equal(plain.remarks, '');
  const w = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), saleMode: 'WHOLESALE', remarks: 'deliver by 5pm', items: [scaleLine(t, P.TOM._id, 1000)] } });
  assert.equal(w.s, 200, JSON.stringify(w.j)); assert.equal(w.j.bill.saleMode, 'WHOLESALE'); assert.equal(w.j.bill.remarks, 'deliver by 5pm'); assert.equal(w.j.bill.total, plain.total);
  const bad = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), saleMode: 'FREE', items: [scaleLine(t, P.TOM._id, 1000)] } });
  assert.equal(bad.s, 400);
});
test('approvals off (default): operator bills manual weight, changed rate and big discount without a manager PIN, all audited', async () => {
  const t = T[0];
  const body = () => ({ idemKey: idem(), items: [{ productId: P.TOM._id, qty: 1500, rate: 2500 }], discount: { type: 'PCT', value: 5000 } });
  const blocked = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: body() });
  assert.equal(blocked.s, 403); assert.equal(blocked.j.code, 'APPROVAL_REQUIRED');
  await call('/settings', { method: 'PUT', tok: mgr, body: { billing: { operatorApprovals: false } } });
  try {
    const ok = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: body() });
    assert.equal(ok.s, 200, JSON.stringify(ok.j));
    const l = ok.j.bill.items[0]; assert.equal(l.src, 'MANUAL'); assert.equal(l.rate, 2500); assert.equal(l.rateSrc, 'MANUAL');
    assert.equal(ok.j.bill.sub, 3750); assert.equal(ok.j.bill.discount, 1875); assert.deepEqual(ok.j.bill.approvals, {});
    const au = (await call('/audit?limit=20', { tok: mgr })).j; const acts = (au.rows || au).map((a) => a.action);
    assert.ok(acts.includes('MANUAL_WEIGHT') && acts.includes('MANUAL_RATE'));
  } finally { await call('/settings', { method: 'PUT', tok: mgr, body: { billing: { operatorApprovals: true } } }); }
});
test('customer typed on the bill: new mobile creates the customer, known mobile reuses it and updates changed name / address', async () => {
  const t = T[1], mobile = '98' + String(Date.now()).slice(-8);
  const sell = (customer, extra = {}) => call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), customer, items: [scaleLine(t, P.TOM._id, 1000)], ...extra } });
  const find = async () => (await call('/customers?q=' + mobile, { tok: mgr })).j.filter((c) => c.mobile === mobile);
  const a = await sell({ mobile, name: 'Ramesh Patel', address: 'Old Street' });
  assert.equal(a.s, 200, JSON.stringify(a.j));
  let cs = await find(); assert.equal(cs.length, 1); assert.equal(cs[0].name, 'Ramesh Patel'); assert.equal(a.j.bill.customerId, cs[0]._id); assert.equal(cs[0].balance, 0);
  const b = await sell({ mobile, name: 'Ramesh Patel', address: 'New Road 12' });           // same number, new address, no customerId sent
  assert.equal(b.s, 200); assert.equal(b.j.bill.customerId, cs[0]._id); assert.equal(b.j.bill.customerAddress, 'New Road 12');
  const c = await sell({ mobile, name: 'Ramesh P. Patel', address: 'New Road 12' }, { customerId: cs[0]._id });
  assert.equal(c.s, 200); assert.equal(c.j.bill.customer, 'Ramesh P. Patel');
  cs = await find(); assert.equal(cs.length, 1, 'still one customer'); assert.equal(cs[0].name, 'Ramesh P. Patel'); assert.equal(cs[0].address, 'New Road 12'); assert.equal(cs[0].balance, 0);
  const walk = await sell({ name: 'No Mobile', mobile: '', address: '' });                  // name only = plain walk-in, nothing stored
  assert.equal(walk.s, 200); assert.equal(walk.j.bill.customerId, null);
});
test('next bill number shown on screen is the number the bill really gets', async () => {
  const t = T[2];
  const peek = (await call('/bills/next-number', { key: t.terminalKey, tok: t.tok })).j.no;
  assert.match(peek, /^INV\/\d{4}-\d{2}\/C4-\d{6}$/);
  const b = (await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [scaleLine(t, P.TOM._id, 1000)] } })).j.bill;
  assert.equal(b.no, peek);
  assert.notEqual((await call('/bills/next-number', { key: t.terminalKey, tok: t.tok })).j.no, peek);
});
test('payment modes: default is cash and UPI only; a switched-off mode is refused by the server', async () => {
  const t = T[0];
  assert.deepEqual(require('../server/services/settings').DEFAULTS.billing.paymentModes, ['CASH', 'UPI']);
  const pay = (mode) => call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [scaleLine(t, P.TOM._id, 1000)], payments: [{ mode, amount: 3000 }] } });
  const set = (paymentModes) => call('/settings', { method: 'PUT', tok: mgr, body: { billing: { paymentModes } } });
  assert.equal((await set([])).s, 400);
  assert.deepEqual((await set(['UPI', 'CASH', 'BITCOIN'])).j.billing.paymentModes, ['CASH', 'UPI']);
  try {
    assert.equal((await pay('CASH')).s, 200); assert.equal((await pay('UPI')).s, 200);
    const card = await pay('CARD'); assert.equal(card.s, 400); assert.match(card.j.error, /CARD is switched off/);
    assert.equal((await pay('CREDIT')).s, 400);
  } finally { await set(['CASH', 'UPI', 'CARD', 'BANK', 'CREDIT']); }
  assert.equal((await pay('CARD')).s, 200);
});
test('scheduled price applies at effective time', async () => {
  const at = new Date(Date.now() + 2500).toISOString();
  const r = await call(`/products/${P.ONI._id}/price`, { method: 'POST', tok: mgr, body: { rate: 3100, effectiveAt: at } });
  assert.equal(r.j.scheduled, true);
  await new Promise((x) => setTimeout(x, 2700));
  await require('../server/services/products').startScheduler()();
  const p = (await call('/products', { tok: mgr })).j.find((x) => x.code === 'ONI'); assert.equal(p.rate, 3100);
});
test('duplicate submit (same idemKey) returns the same invoice once', async () => {
  const t = T[2], k = idem();
  const body = { idemKey: k, items: [{ productId: P.LEM._id, qty: 10 }] };
  const [a, b] = await Promise.all([call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body }), call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body })]);
  assert.equal(a.j.bill.no, b.j.bill.no);
  const all = (await call('/bills?limit=500', { tok: mgr })).j.filter((x) => x.idemKey === k); assert.equal(all.length, 1);
});
test('manual weight needs approval; manager PIN approves; audited', async () => {
  const t = T[0];
  const body = { idemKey: idem(), items: [{ productId: P.POT._id, qty: 2500 }] };
  const r1 = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body });
  assert.equal(r1.s, 403); assert.equal(r1.j.extra.action, 'weight_manual');
  const bad = await call('/approve', { method: 'POST', tok: t.tok, body: { username: 'operator2', secret: '1112', action: 'weight_manual' } });
  assert.equal(bad.s, 403);
  const ap = await call('/approve', { method: 'POST', tok: t.tok, body: { username: 'shopmgr', secret: '9999', action: 'weight_manual' } });
  assert.equal(ap.s, 200);
  const r2 = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { ...body, approvals: { weight_manual: ap.j.approval } } });
  assert.equal(r2.s, 200, JSON.stringify(r2.j)); assert.equal(r2.j.bill.items[0].src, 'MANUAL'); assert.equal(r2.j.bill.approvals.weight_manual, 'shopmgr');
  const au = (await call('/audit?action=MANUAL_WEIGHT', { tok: mgr })).j; assert.ok(au.some((a) => a.approvedBy === 'shopmgr'));
  // forged scale reading is treated as manual
  const forged = { ...scaleLine(t, P.POT._id, 2500) }; forged.reading = { ...forged.reading, grams: 1000 }; forged.qty = 1000;
  const r3 = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [forged] } });
  assert.equal(r3.j.code, 'APPROVAL_REQUIRED');
});
test('discount above operator limit needs approval', async () => {
  const t = T[1];
  const body = { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 100 }], discount: { type: 'PCT', value: 500 } };
  const r = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body });
  assert.equal(r.j.code, 'APPROVAL_REQUIRED'); assert.equal(r.j.extra.value, 500);
  const ok2 = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { ...body, idemKey: idem(), discount: { type: 'PCT', value: 200 } } });
  assert.equal(ok2.s, 200); assert.equal(ok2.j.bill.discount, 1000); assert.equal(ok2.j.bill.total, 49000);
  const ap = (await call('/approve', { method: 'POST', tok: t.tok, body: { username: 'shopmgr', secret: '9999', action: 'discount', value: 500 } })).j.approval;
  const r2 = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { ...body, approvals: { discount: ap } } });
  assert.equal(r2.s, 200); assert.equal(r2.j.bill.discount, 2500);
});
test('mixed payment must match total; cash change', async () => {
  const t = T[3];
  const bad = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 7 }], payments: [{ mode: 'CASH', amount: 1000 }, { mode: 'UPI', amount: 1000 }] } });
  assert.equal(bad.s, 400);
  const ok = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 7 }], payments: [{ mode: 'CASH', amount: 1500 }, { mode: 'UPI', amount: 2000 }], tendered: 2000 } });
  assert.equal(ok.s, 200, JSON.stringify(ok.j)); assert.equal(ok.j.bill.mode, 'MIXED'); assert.equal(ok.j.bill.change, 500);
});
test('credit sale -> ledger & outstanding; limit blocks; payment reduces', async () => {
  const c = (await call('/customers', { method: 'POST', tok: mgr, body: { name: 'Hotel Raj', mobile: '9876543210', creditAllowed: true, creditLimit: 500000 } })).j;
  const t = T[0];
  const r = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), customerId: c._id, items: [scaleLine(t, P.APP._id, 20000)], payments: [{ mode: 'CREDIT', amount: 240000 }] } });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  let cc = (await call('/customers/' + c._id, { tok: mgr })).j; assert.equal(cc.balance, 240000);
  const over = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), customerId: c._id, items: [scaleLine(t, P.APP._id, 30000)], payments: [{ mode: 'CREDIT', amount: 360000 }] } });
  assert.equal(over.j.code, 'APPROVAL_REQUIRED'); assert.match(over.j.error, /credit limit exceeded/i);
  await call(`/customers/${c._id}/payments`, { method: 'POST', tok: mgr, body: { amount: 40000, mode: 'UPI' } });
  const led = (await call(`/customers/${c._id}/ledger`, { tok: mgr })).j; assert.equal(led.closing, 200000);
  const walk = await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 1 }], payments: [{ mode: 'CREDIT', amount: 500 }] } });
  assert.equal(walk.s, 400);
});
test('return (partial) reverses stock and customer; cancel reverses fully; deleted never', async () => {
  const t = T[1];
  const s0 = (await call('/products', { tok: mgr })).j.find((p) => p.code === 'LEM').stock;
  const b = (await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 20 }, { productId: P.BAN._id, qty: 2 }] } })).j.bill;
  const opRet = await call(`/bills/${b._id}/returns`, { method: 'POST', tok: t.tok, key: t.terminalKey, body: { items: [{ line: 0, qty: 5 }], reason: 'damaged', refundMode: 'CASH' } });
  assert.equal(opRet.j.code, 'APPROVAL_REQUIRED');
  const ret = await call(`/bills/${b._id}/returns`, { method: 'POST', tok: mgr, body: { items: [{ line: 0, qty: 5 }], reason: 'damaged', refundMode: 'CASH' } });
  assert.equal(ret.s, 200, JSON.stringify(ret.j)); assert.equal(ret.j.amount, 2500);
  let s1 = (await call('/products', { tok: mgr })).j.find((p) => p.code === 'LEM').stock; assert.equal(s0 - s1, 15);
  const over = await call(`/bills/${b._id}/returns`, { method: 'POST', tok: mgr, body: { items: [{ line: 0, qty: 16 }], reason: 'x too many' } }); assert.equal(over.s, 400);
  const bb = (await call('/bills/' + b._id, { tok: mgr })).j; assert.equal(bb.status, 'PARTIALLY_RETURNED');
  const canc = await call(`/bills/${bb._id}/cancel`, { method: 'POST', tok: mgr, body: { reason: 'wrong bill' } }); assert.equal(canc.s, 409);
  const b2 = (await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 30 }] } })).j.bill;
  const opc = await call(`/bills/${b2._id}/cancel`, { method: 'POST', tok: t.tok, key: t.terminalKey, body: { reason: 'mistake' } }); assert.equal(opc.j.code, 'APPROVAL_REQUIRED');
  const c2 = await call(`/bills/${b2._id}/cancel`, { method: 'POST', tok: mgr, body: { reason: 'customer left' } }); assert.equal(c2.s, 200); assert.equal(c2.j.status, 'CANCELLED');
  s1 = (await call('/products', { tok: mgr })).j.find((p) => p.code === 'LEM').stock; assert.equal(s0 - s1, 15);
  const still = (await call('/bills/' + b2._id, { tok: mgr })).j; assert.equal(still.no, b2.no);
});
test('purchase increases stock and supplier payable; wastage reduces stock', async () => {
  const s = (await call('/suppliers', { method: 'POST', tok: mgr, body: { name: 'APMC Trader' } })).j;
  const st0 = (await call('/products', { tok: mgr })).j.find((p) => p.code === 'POT').stock;
  const pu = await call('/purchases', { method: 'POST', tok: mgr, body: { supplierId: s._id, invoiceNo: 'A-1', items: [{ productId: P.POT._id, qty: 100000, rate: 1800 }], charges: 5000, paid: { amount: 100000, mode: 'CASH' } } });
  assert.equal(pu.s, 200, JSON.stringify(pu.j)); assert.equal(pu.j.total, 185000);
  const dup = await call('/purchases', { method: 'POST', tok: mgr, body: { supplierId: s._id, invoiceNo: 'A-1', items: [{ productId: P.POT._id, qty: 1000, rate: 1800 }] } }); assert.equal(dup.s, 409);
  await call('/stock/wastage', { method: 'POST', tok: mgr, body: { productId: P.POT._id, qty: 2000, reason: 'SPOILAGE' } });
  const st1 = (await call('/products', { tok: mgr })).j.find((p) => p.code === 'POT').stock; assert.equal(st1 - st0, 98000);
  const sup = (await call('/suppliers', { tok: mgr })).j.find((x) => x._id === s._id); assert.equal(sup.balance, 85000);
  const led = (await call('/stock/ledger/' + P.POT._id, { tok: mgr })).j; assert.ok(led.some((r) => r.type === 'PURCHASE') && led.some((r) => r.type === 'WASTAGE'));
});
test('permissions: operator blocked from manager functions; no terminal = no billing', async () => {
  const t = T[0];
  for (const [m, p, b] of [['POST', `/products/${P.TOM._id}/price`, { rate: 1 }], ['GET', '/users'], ['GET', '/dashboard'], ['POST', '/stock/adjust', { productId: P.TOM._id, qty: 5, reason: 'xyz' }], ['GET', '/audit'], ['PUT', '/settings', {}]]) {
    const r = await call(p, { method: m, tok: t.tok, key: t.terminalKey, body: b }); assert.equal(r.s, 403, p);
  }
  const mine = (await call('/bills?limit=500', { tok: t.tok, key: t.terminalKey })).j; assert.ok(mine.every((b) => b.by === 'operator1'));
  const fake = await call('/bills', { method: 'POST', tok: t.tok, key: 'not-a-key', body: { idemKey: idem(), items: [] } }); assert.equal(fake.s, 401);
  const op = (await call('/products', { tok: t.tok, key: t.terminalKey })).j[0]; assert.equal(op.purchaseRate, undefined);
});
test('hold & resume; cross-counter resume blocked', async () => {
  const [a, b] = T;
  const h = (await call('/held', { method: 'POST', tok: a.tok, key: a.terminalKey, body: { items: [{ productId: P.LEM._id, name: 'Lemon', unit: 'PCS', qty: 3, rate: 500, amount: 1500 }], customer: { name: 'Ramesh' } } })).j;
  assert.equal((await call(`/held/${h._id}/resume`, { method: 'POST', tok: b.tok, key: b.terminalKey })).s, 403);
  const r = await call(`/held/${h._id}/resume`, { method: 'POST', tok: a.tok, key: a.terminalKey }); assert.equal(r.s, 200); assert.equal(r.j.items[0].qty, 3);
  assert.equal((await call(`/held/${h._id}/resume`, { method: 'POST', tok: a.tok, key: a.terminalKey })).s, 404);
});
test('shift: expected vs actual cash', async () => {
  const t = T[3];
  assert.equal((await call('/shift/open', { method: 'POST', tok: t.tok, key: t.terminalKey, body: { openingCash: 100000 } })).s, 200);
  await call('/bills', { method: 'POST', key: t.terminalKey, tok: t.tok, body: { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 10 }] } });
  const c = await call('/shift/close', { method: 'POST', tok: t.tok, key: t.terminalKey, body: { actualCash: 104900 } });
  assert.equal(c.j.expectedCash, 105000); assert.equal(c.j.difference, -100);
});
test('dashboard & reports aggregate all counters; CSV export', async () => {
  const d = (await call('/dashboard', { tok: mgr })).j;
  assert.ok(d.bills >= 40); assert.equal(d.counters.filter((c) => c.code.startsWith('COUNTER')).length, 4);
  const pr = (await call('/reports/product', { tok: mgr })).j; assert.ok(pr.find((x) => x.product === 'Tomato').qty >= 40000);
  const r = await fetch(base + '/api/reports/counter?format=csv', { headers: { Authorization: 'Bearer ' + mgr } }); const txt = await r.text(); assert.match(txt, /counter,bills,sales/);
  const profit = await call('/reports/profit', { tok: mgr }); assert.equal(profit.s, 200); assert.ok('margin' in profit.j[0]);
});
test('logout / disabled user ends session immediately', async () => {
  const tok = await login('operator4', 'operator123', T[3].terminalKey);
  const users = (await call('/users', { tok: mgr })).j; const u = users.find((x) => x.username === 'operator4');
  await call('/users/' + u._id, { method: 'PUT', tok: mgr, body: { active: false } });
  assert.equal((await call('/me', { tok, key: T[3].terminalKey })).s, 401);
  await call('/users/' + u._id, { method: 'PUT', tok: mgr, body: { active: true } });
  let locked = 0; for (let i = 0; i < 6; i++) { const r = await call('/login', { method: 'POST', body: { username: 'operator3', password: 'bad' } }); if (/Too many/.test(r.j.error)) locked++; }
  assert.ok(locked >= 1);
});
test('backup -> change -> restore brings data back', async () => {
  const b = (await call('/backups', { method: 'POST', tok: mgr })).j; assert.equal(b.status, 'OK');
  const n0 = (await call('/bills?limit=500', { tok: mgr })).j.length;
  await call('/bills', { method: 'POST', key: T[0].terminalKey, tok: T[0].tok, body: { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 1 }] } });
  const r = await call('/backups/restore', { method: 'POST', tok: mgr, body: { file: b.file, confirm: 'RESTORE', password: 'manager123' } });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await call('/bills?limit=500', { tok: mgr })).j.length, n0);
});
test('transaction rollback: failure mid-sale leaves no partial data', async () => {
  const { db } = require('../server/db');
  await call('/settings', { method: 'PUT', tok: mgr, body: { billing: { allowNegativeStock: false } } });
  const before = (await db.c.bills.count({})), st = (await db.c.products.findOne({ _id: P.LEM._id })).stock;
  const r = await call('/bills', { method: 'POST', key: T[0].terminalKey, tok: T[0].tok, body: { idemKey: idem(), items: [{ productId: P.LEM._id, qty: 1 }, { productId: P.BAN._id, qty: 999999 }] } });
  assert.equal(r.s, 400); assert.match(r.j.error, /Insufficient stock/);
  assert.equal(await db.c.bills.count({}), before); assert.equal((await db.c.products.findOne({ _id: P.LEM._id })).stock, st);
  assert.equal(await db.c.tx_journal.count({}), 0);
  await call('/settings', { method: 'PUT', tok: mgr, body: { billing: { allowNegativeStock: true } } });
});
