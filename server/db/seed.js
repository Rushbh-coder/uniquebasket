'use strict';
/** First-run data. Production: only the manager login (password from setup screen / ADMIN_PASSWORD).
 *  SEED_DEMO=1 (development only) adds demo operators, counters and products. */
const bcrypt = require('bcryptjs');
const { db, tx } = require('./index');
const cfg = require('../config');
const log = require('../lib/log');
async function seed() {
  if (!(await db.c.users.count({}))) {
    let pw = cfg.adminPassword;
    if (!pw || pw.length < 8) {
      if (!cfg.seedDemo) throw new Error('First start: set a manager password (min 8 characters) in the setup screen or ADMIN_PASSWORD');
      pw = 'manager123';
    }
    await db.c.users.insert({ username: 'manager', name: 'Shop Manager', role: 'OWNER', pass: bcrypt.hashSync(pw, 10), active: true, createdAt: new Date().toISOString() });
    log.info('created manager login');
  }
  if (!cfg.seedDemo) return;
  if (process.env.NODE_ENV === 'production') { log.warn('SEED_DEMO ignored in production'); return; }
  for (let i = 1; i <= 4; i++) {
    const u = 'operator' + i;
    if (!(await db.c.users.findOne({ username: u }))) await db.c.users.insert({ username: u, name: 'Operator ' + i, role: 'OPERATOR', pass: bcrypt.hashSync('operator123', 10), pinHash: bcrypt.hashSync('111' + i, 10), active: true, createdAt: new Date().toISOString() });
  }
  if (!(await db.c.users.findOne({ username: 'shopmgr' }))) await db.c.users.insert({ username: 'shopmgr', name: 'Floor Manager', role: 'MANAGER', pass: bcrypt.hashSync('manager123', 10), pinHash: bcrypt.hashSync('9999', 10), active: true });
  if (!(await db.c.products.count({}))) {
    const now = new Date().toISOString();
    const P = [['TOM', 'Tomato', 'ટામેટા', 'Vegetables', 'KG', 3000, 2200], ['POT', 'Potato', 'બટાકા', 'Vegetables', 'KG', 2400, 1700], ['ONI', 'Onion', 'ડુંગળી', 'Vegetables', 'KG', 2800, 2000], ['APP', 'Apple', 'સફરજન', 'Fruits', 'KG', 12000, 9000], ['BAN', 'Banana', 'કેળા', 'Fruits', 'DOZEN', 6000, 4200], ['LEM', 'Lemon', 'લીંબુ', 'Vegetables', 'PCS', 500, 300]];
    await tx(async (t) => {
      for (const [code, name, localName, category, unit, rate, purchaseRate] of P) {
        const w = unit === 'KG';
        const p = await t.products.insert({ code, name, localName, category, unit, rate, purchaseRate, taxRate: 0, weighable: w, allowManualWeight: true, allowManualRate: false, active: true, stock: w ? 500000 : 1000, minStock: w ? 20000 : 50, priceVersion: 1, createdAt: now, updatedAt: now });
        await t.rates.insert({ productId: p._id, productName: name, old: null, rate, version: 1, at: now, effectiveAt: now, by: 'seed', reason: 'Created' });
        await t.inventory.insert({ productId: p._id, productName: name, unit, at: now, date: now.slice(0, 10), type: 'OPENING', in: p.stock, out: 0, balance: p.stock, ref: 'Demo seed', by: 'seed' });
      }
    }, 'seed');
  }
  log.info('demo seed ready (operator1-4 / operator123, PIN 1111-1114; shopmgr / manager123 PIN 9999)');
}
module.exports = { seed };
