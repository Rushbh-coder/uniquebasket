'use strict';
/** NeDB adapter — keeps the existing "Single PC (offline)" mode working with the same files as before. */
const path = require('path');
const { Conflict } = require('../lib/errors');
const { hexId } = require('../lib/ids');
const dup = (e) => { if (e && e.errorType === 'uniqueViolated') { const c = new Conflict('Duplicate record'); c.duplicateKey = true; return c; } return e; };
async function open(dir) {
  const Datastore = require('@seald-io/nedb');
  const cache = new Map();
  const collection = (n) => {
    if (cache.has(n)) return cache.get(n);
    const s = new Datastore({ filename: path.join(dir, n + '.db'), autoload: true });
    s.setAutocompactionInterval(6 * 3600e3);
    const c = {
      name: n, store: s,
      createIndex: (spec, o = {}) => s.ensureIndexAsync({ fieldName: Object.keys(spec).length > 1 ? Object.keys(spec) : Object.keys(spec)[0], unique: !!o.unique, sparse: !!(o.sparse || o.partialFilterExpression) }).catch(() => {}),
      find: async (q = {}, o = {}) => { let cur = s.findAsync(q, o.projection || {}); if (o.sort) cur = cur.sort(o.sort); if (o.skip) cur = cur.skip(o.skip); if (o.limit) cur = cur.limit(o.limit); return cur; },
      findOne: async (q = {}, o = {}) => { if (o.sort) return (await c.find(q, { ...o, limit: 1 }))[0] || null; return s.findOneAsync(q, o.projection || {}); },
      count: (q = {}) => s.countAsync(q),
      insert: async (doc) => { const d = { ...doc }; if (d._id == null) d._id = hexId(); try { return await s.insertAsync(d); } catch (e) { throw dup(e); } },
      update: async (q, u, o = {}) => { try { const r = await s.updateAsync(q, u, { upsert: !!o.upsert, multi: !!o.multi }); return r.numAffected; } catch (e) { throw dup(e); } },
      findOneAndUpdate: async (q, u, o = {}) => { try { const r = await s.updateAsync(q, u, { upsert: !!o.upsert, returnUpdatedDocs: true }); return r.affectedDocuments || null; } catch (e) { throw dup(e); } },
      remove: async (q, o = {}) => s.removeAsync(q, { multi: !!o.multi }),
      replace: async (doc) => { try { await s.updateAsync({ _id: doc._id }, doc, { upsert: true }); } catch (e) { throw dup(e); } },
    };
    cache.set(n, c); return c;
  };
  const stores = [];
  const tracked = (n) => { const fresh = !cache.has(n), c = collection(n); if (fresh) stores.push(c.store); return c; };
  // stop the compaction timers so the process can exit (tests, tools); data is already on disk after every write
  return { kind: 'nedb', collection: tracked, close: async () => { for (const s of stores) { s.stopAutocompaction(); await s.compactDatafileAsync().catch(() => {}); } } };
}
module.exports = { open };
