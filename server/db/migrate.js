'use strict';
/** Versioned, idempotent data migrations. v1 upgrades data written by app v2.0 (Mongo/NeDB) in place —
 *  nothing is deleted; bill numbers and counter series continue. */
const { businessDate, financialYear } = require('../lib/dates');
const log = require('../lib/log');
const M = [
  { id: 1, name: 'upgrade v2 data', async up(c) {
    for (const p of await c.products.find({})) {
      const set = { weighable: p.weighable != null ? p.weighable : p.unit === 'KG', priceVersion: p.priceVersion || 1, updatedAt: p.updatedAt || new Date().toISOString(), active: p.active !== false };
      const u = { $set: set };
      if (p.code === '' || p.code == null) u.$unset = { code: 1 };
      await c.products.update({ _id: p._id }, u);
      if (!(await c.inventory.count({ productId: p._id })) && p.stock) await c.inventory.insert({ productId: p._id, productName: p.name, unit: p.unit, at: new Date().toISOString(), date: businessDate(), type: 'OPENING', in: p.stock > 0 ? p.stock : 0, out: p.stock < 0 ? -p.stock : 0, balance: p.stock, ref: 'Migrated from v2', by: 'system' });
    }
    for (const r of await c.rates.find({ productName: { $exists: false } })) { const p = await c.products.findOne({ _id: r.productId }); await c.rates.update({ _id: r._id }, { $set: { productName: p ? p.name : '', effectiveAt: r.at } }); }
    for (const b of await c.bills.find({ payments: { $exists: false } })) {
      await c.bills.update({ _id: b._id }, { $set: { date: b.at ? businessDate(new Date(b.at)) : b.date, terminalCode: b.counter || 'C1', series: b.counter || 'C1', payments: [{ mode: b.mode || 'CASH', amount: b.total }], creditAmount: b.mode === 'CREDIT' ? b.total : 0, tax: 0, taxable: b.total, returnedAmount: 0, printCount: 1, reprints: [], legacy: true } });
    }
    for (const s of await c.settings.find({})) {
      const m = /^seq-([A-Z0-9]+)$/.exec(s._id); if (!m) continue;
      const key = `seq-${m[1]}-${financialYear()}`;
      if (!(await c.settings.findOne({ _id: key }))) await c.settings.insert({ _id: key, v: s.v });
    }
    for (const u of await c.users.find({ active: { $exists: false } })) await c.users.update({ _id: u._id }, { $set: { active: true } });
  } },
  { id: 2, name: 'payment modes: cash and UPI only', async up(c) {
    // the shop takes cash and UPI; other modes can be switched on again in Settings
    const s = await c.settings.findOne({ _id: 'config' });
    if (s && s.v && s.v.billing) await c.settings.update({ _id: 'config' }, { $set: { 'v.billing.paymentModes': ['CASH', 'UPI'] } });
  } },
];
async function run(c) {
  for (const m of M) {
    if (await c.migrations.findOne({ _id: 'm' + m.id })) continue;
    log.info(`migration ${m.id}: ${m.name}`);
    await m.up(c);
    await c.migrations.insert({ _id: 'm' + m.id, name: m.name, at: new Date().toISOString() });
  }
}
module.exports = { run };
