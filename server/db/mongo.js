'use strict';
/** MongoDB adapter (local MongoDB on the manager PC, or Atlas). Only the server PC ever holds MONGO_URI. */
const { hexId } = require('../lib/ids');
const { Conflict } = require('../lib/errors');
const dup = (e) => { if (e && e.code === 11000) { const c = new Conflict('Duplicate record'); c.duplicateKey = true; c.keyValue = e.keyValue; return c; } return e; };
const hasOps = (u) => Object.keys(u).some((k) => k[0] === '$');
function wrap(c) {
  return {
    name: c.collectionName,
    createIndex: (spec, opts) => c.createIndex(spec, opts),
    find: (q = {}, o = {}) => { let cur = c.find(q, { projection: o.projection }); if (o.sort) cur = cur.sort(o.sort); if (o.skip) cur = cur.skip(o.skip); if (o.limit) cur = cur.limit(o.limit); return cur.toArray(); },
    findOne: (q = {}, o = {}) => c.findOne(q, { projection: o.projection, sort: o.sort }),
    count: (q = {}) => c.countDocuments(q),
    insert: async (doc) => { const d = { ...doc }; if (d._id == null) d._id = hexId(); try { await c.insertOne(d); } catch (e) { throw dup(e); } return d; },
    update: async (q, u, o = {}) => {
      try {
        if (!hasOps(u)) { const r = await c.replaceOne(q, u, { upsert: !!o.upsert }); return r.matchedCount + (r.upsertedCount || 0); }
        const r = o.multi ? await c.updateMany(q, u, { upsert: !!o.upsert }) : await c.updateOne(q, u, { upsert: !!o.upsert });
        return r.matchedCount + (r.upsertedCount || 0);
      } catch (e) { throw dup(e); }
    },
    findOneAndUpdate: async (q, u, o = {}) => {
      try { const r = await c.findOneAndUpdate(q, u, { upsert: !!o.upsert, returnDocument: 'after', includeResultMetadata: false }); return r && r.value !== undefined && r.ok !== undefined ? r.value : r; } catch (e) { throw dup(e); }
    },
    remove: async (q, o = {}) => { const r = o.multi ? await c.deleteMany(q) : await c.deleteOne(q); return r.deletedCount; },
    replace: async (doc) => { try { await c.replaceOne({ _id: doc._id }, doc, { upsert: true }); } catch (e) { throw dup(e); } },
  };
}
async function open(uri, dbName) {
  if (/^mongodb\+srv:/.test(uri) && process.env.DNS_SERVERS !== 'system')
    require('dns').setServers((process.env.DNS_SERVERS || '8.8.8.8,1.1.1.1,8.8.4.4').split(',')); // fixes "querySrv ECONNREFUSED" on some ISPs
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  await client.connect();
  const d = client.db(dbName);
  const cache = new Map();
  return {
    kind: 'mongo', client,
    collection: (n) => { if (!cache.has(n)) cache.set(n, wrap(d.collection(n))); return cache.get(n); },
    close: () => client.close(),
  };
}
module.exports = { open };
