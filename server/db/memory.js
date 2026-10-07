'use strict';
/** In-memory store with the same interface as the Mongo/NeDB adapters. Used by automated tests. */
const { match, applyUpdate, sortDocs, project, clone, seedFromQuery } = require('./query');
const { hexId } = require('../lib/ids');
const { Conflict } = require('../lib/errors');
class MemCollection {
  constructor(name) { this.name = name; this.docs = new Map(); this.uniques = []; }
  checkUnique(doc, selfId) {
    for (const { fields, sparse } of this.uniques) {
      const key = fields.map((f) => JSON.stringify(require('./query').get(doc, f)));
      if (sparse && fields.some((f) => require('./query').get(doc, f) == null)) continue;
      for (const d of this.docs.values()) {
        if (d._id === selfId) continue;
        if (sparse && fields.some((f) => require('./query').get(d, f) == null)) continue;
        if (fields.every((f, i) => JSON.stringify(require('./query').get(d, f)) === key[i])) {
          const e = new Conflict(`Duplicate ${fields.join('+')} in ${this.name}`); e.duplicateKey = true; throw e;
        }
      }
    }
  }
  async createIndex(spec, opts = {}) { if (opts.unique) this.uniques.push({ fields: Object.keys(spec), sparse: !!opts.sparse || !!opts.partialFilterExpression }); }
  async find(q = {}, o = {}) {
    let r = [...this.docs.values()].filter((d) => match(d, q));
    r = sortDocs(r, o.sort);
    if (o.skip) r = r.slice(o.skip);
    if (o.limit) r = r.slice(0, o.limit);
    return r.map((d) => project(clone(d), o.projection));
  }
  async findOne(q = {}, o = {}) { return (await this.find(q, { ...o, limit: 1 }))[0] || null; }
  async count(q = {}) { return [...this.docs.values()].filter((d) => match(d, q)).length; }
  async insert(doc) {
    const d = clone(doc); if (d._id == null) d._id = hexId();
    if (this.docs.has(d._id)) { const e = new Conflict('Duplicate _id'); e.duplicateKey = true; throw e; }
    this.checkUnique(d); this.docs.set(d._id, d); return clone(d);
  }
  async update(q, u, o = {}) {
    const hits = [...this.docs.values()].filter((d) => match(d, q));
    if (!hits.length) {
      if (!o.upsert) return 0;
      const base = { _id: q._id || hexId(), ...seedFromQuery(q) };
      const d = applyUpdate(base, u); this.checkUnique(d); this.docs.set(d._id, d); return 1;
    }
    const list = o.multi ? hits : hits.slice(0, 1);
    const next = list.map((d) => applyUpdate(d, u));
    next.forEach((d) => this.checkUnique(d, d._id));
    next.forEach((d) => this.docs.set(d._id, d));
    return list.length;
  }
  async findOneAndUpdate(q, u, o = {}) {
    const cur = await this.findOne(q);
    if (!cur && !o.upsert) return null;
    await this.update(q, u, { upsert: o.upsert });
    return this.findOne(cur ? { _id: cur._id } : q);
  }
  async remove(q, o = {}) {
    const hits = [...this.docs.values()].filter((d) => match(d, q));
    const list = o.multi ? hits : hits.slice(0, 1);
    list.forEach((d) => this.docs.delete(d._id)); return list.length;
  }
  async replace(doc) { this.checkUnique(doc, doc._id); this.docs.set(doc._id, clone(doc)); }
}
async function open() {
  const cols = new Map();
  return { kind: 'memory', supportsTransactions: false, collection: (n) => { if (!cols.has(n)) cols.set(n, new MemCollection(n)); return cols.get(n); }, close: async () => {} };
}
module.exports = { open };
