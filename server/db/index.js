'use strict';
/**
 * Database facade.
 *  - db.c.<name>          plain collection access
 *  - db.tx(async t => {}) critical multi-document write. Guarantees:
 *      1. serialised: only one tx runs at a time in this server process (global mutex) -> no races between counters
 *      2. all-or-nothing: every write first records an undo entry in `tx_journal`; on error the undo entries are
 *         applied in reverse; on startup any journal left by a crash/power cut is rolled back.
 *    Works the same on MongoDB (standalone or Atlas), NeDB and the in-memory test store.
 */
const { Mutex } = require('../lib/mutex');
const { hexId } = require('../lib/ids');
const { match } = require('./query');
const log = require('../lib/log');

const COLLECTIONS = ['users', 'products', 'bills', 'settings', 'rates', 'audit', 'terminals', 'customers', 'customer_ledger',
  'suppliers', 'supplier_ledger', 'purchases', 'inventory', 'held_bills', 'cash_sessions', 'returns', 'price_schedule',
  'categories', 'tx_journal', 'migrations', 'backups', 'sync_queue', 'sessions'];

const db = { c: {}, kind: null, store: null };
const mutex = new Mutex();

async function connect(cfg) {
  let store;
  if (cfg.memory) store = await require('./memory').open();
  else if (cfg.mongoUri) store = await require('./mongo').open(cfg.mongoUri, cfg.mongoDb);
  else store = await require('./nedb').open(cfg.dataDir);
  db.store = store; db.kind = store.kind;
  COLLECTIONS.forEach((n) => { db.c[n] = store.collection(n); });
  await recoverEarly();
  await require('./migrate').run(db.c);
  await ensureIndexes();
  return db;
}

async function ensureIndexes() {
  const I = (c, spec, o) => db.c[c].createIndex(spec, o).catch((e) => log.warn(`index ${c} ${JSON.stringify(spec)}: ${e.message}`));
  await Promise.all([
    I('users', { username: 1 }, { unique: true }),
    I('bills', { no: 1 }, { unique: true }),
    I('bills', { idemKey: 1 }, { unique: true, sparse: true }),
    I('bills', { date: 1 }), I('bills', { at: -1 }), I('bills', { customerId: 1 }), I('bills', { terminalId: 1, date: 1 }),
    I('products', { code: 1 }, { unique: true, sparse: true }),
    I('products', { barcode: 1 }, { unique: true, sparse: true }),
    I('products', { name: 1 }),
    I('customers', { mobile: 1 }), I('customers', { code: 1 }, { unique: true, sparse: true }),
    I('customer_ledger', { customerId: 1, at: 1 }),
    I('supplier_ledger', { supplierId: 1, at: 1 }),
    I('inventory', { productId: 1, at: 1 }), I('inventory', { date: 1 }),
    I('rates', { productId: 1, at: -1 }),
    I('audit', { at: -1 }),
    I('terminals', { code: 1 }, { unique: true }),
    I('held_bills', { terminalId: 1 }),
    I('purchases', { date: 1 }), I('returns', { billId: 1 }),
    I('cash_sessions', { terminalId: 1, status: 1 }),
    I('price_schedule', { status: 1, effectiveAt: 1 }),
  ]);
}

/** wraps a collection so each write first records how to undo it */
function journaled(name, col, j) {
  const note = async (entries) => {
    if (!entries.length) return;
    j.undo.push(...entries);
    await db.c.tx_journal.update({ _id: j._id }, { $push: { undo: { $each: entries } } });
  };
  const before = async (q, multi) => (multi ? col.find(q) : col.findOne(q).then((d) => (d ? [d] : [])));
  const base = {}; for (const m of ['find', 'findOne', 'count', 'createIndex', 'replace']) base[m] = col[m].bind(col);
  return {
    ...base,
    insert: async (doc) => {
      const d = { ...doc }; if (d._id == null) d._id = hexId();
      await note([{ c: name, op: 'delete', id: d._id }]);
      return col.insert(d);
    },
    update: async (q, u, o = {}) => {
      const prev = await before(q, o.multi);
      if (!prev.length && o.upsert) {
        const n = await col.update(q, u, o);
        const created = await col.findOne(q);
        if (created) await note([{ c: name, op: 'delete', id: created._id }]);
        return n;
      }
      await note(prev.map((d) => ({ c: name, op: 'restore', doc: d })));
      return col.update(q, u, o);
    },
    findOneAndUpdate: async (q, u, o = {}) => {
      const prev = await col.findOne(q);
      if (prev) await note([{ c: name, op: 'restore', doc: prev }]);
      const r = await col.findOneAndUpdate(q, u, o);
      if (!prev && r) await note([{ c: name, op: 'delete', id: r._id }]);
      return r;
    },
    remove: async (q, o = {}) => {
      const prev = await before(q, o.multi);
      await note(prev.map((d) => ({ c: name, op: 'restore', doc: d })));
      return col.remove(q, o);
    },
  };
}

async function undoAll(entries) {
  for (const e of [...entries].reverse()) {
    try {
      if (e.op === 'delete') await db.c[e.c].remove({ _id: e.id });
      else if (e.op === 'restore') await db.c[e.c].replace(e.doc);
    } catch (err) { log.error(`ROLLBACK STEP FAILED ${e.c} ${e.op}`, err); }
  }
}

function tx(fn, label = 'tx') {
  return mutex.run(async () => {
    const j = { _id: hexId(), at: new Date().toISOString(), label, undo: [] };
    await db.c.tx_journal.insert(j);
    const t = {};
    for (const n of COLLECTIONS) t[n] = n === 'tx_journal' ? db.c[n] : journaled(n, db.c[n], j);
    try {
      const r = await fn(t);
      await db.c.tx_journal.remove({ _id: j._id });
      return r;
    } catch (e) {
      await undoAll(j.undo);
      await db.c.tx_journal.remove({ _id: j._id }).catch(() => {});
      throw e;
    }
  });
}

const recoverEarly = () => recover();
/** roll back transactions interrupted by a crash or power cut */
async function recover() {
  const left = await db.c.tx_journal.find({});
  for (const j of left) {
    log.warn(`Rolling back interrupted transaction ${j.label} from ${j.at} (${(j.undo || []).length} steps)`);
    await undoAll(j.undo || []);
    await db.c.tx_journal.remove({ _id: j._id });
  }
}

module.exports = { db, connect, tx, mutex, COLLECTIONS, match };
