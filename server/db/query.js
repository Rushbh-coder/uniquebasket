'use strict';
/** Mongo-style query matching + update operators, used by the in-memory store (tests/dev).
 *  Only the operator subset this app uses is supported; unknown operators throw so tests fail loudly. */
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
function cmp(a, b) {
  if (a === b) return 0; if (a == null) return -1; if (b == null) return 1;
  return a < b ? -1 : 1;
}
function matchValue(v, cond) {
  if (cond instanceof RegExp) return Array.isArray(v) ? v.some((x) => cond.test(x)) : typeof v === 'string' && cond.test(v);
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).some((k) => k[0] === '$')) {
    return Object.entries(cond).every(([op, x]) => {
      switch (op) {
        case '$eq': return eq(v, x);
        case '$ne': return !eq(v, x);
        case '$in': return x.some((y) => eq(v, y));
        case '$nin': return !x.some((y) => eq(v, y));
        case '$gt': return v != null && cmp(v, x) > 0;
        case '$gte': return v != null && cmp(v, x) >= 0;
        case '$lt': return v != null && cmp(v, x) < 0;
        case '$lte': return v != null && cmp(v, x) <= 0;
        case '$exists': return (v !== undefined) === !!x;
        case '$regex': return matchValue(v, x instanceof RegExp ? x : new RegExp(x, cond.$options || ''));
        case '$options': return true;
        default: throw new Error('Unsupported query operator ' + op);
      }
    });
  }
  return eq(v, cond);
}
const eq = (v, x) => (Array.isArray(v) && !Array.isArray(x) ? v.some((y) => y === x) : JSON.stringify(v) === JSON.stringify(x));
function match(doc, q = {}) {
  return Object.entries(q).every(([k, c]) => {
    if (k === '$or') return c.some((s) => match(doc, s));
    if (k === '$and') return c.every((s) => match(doc, s));
    return matchValue(get(doc, k), c);
  });
}
function setPath(o, p, val) {
  const ks = p.split('.'); let x = o;
  for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null || typeof x[ks[i]] !== 'object') x[ks[i]] = {}; x = x[ks[i]]; }
  x[ks[ks.length - 1]] = val;
}
function unsetPath(o, p) { const ks = p.split('.'); const last = ks.pop(); const x = ks.reduce((a, k) => (a ? a[k] : a), o); if (x) delete x[last]; }
/** returns a NEW document with update applied */
function applyUpdate(doc, u) {
  const d = clone(doc);
  if (!Object.keys(u).some((k) => k[0] === '$')) return { ...clone(u), _id: d._id };
  for (const [op, fields] of Object.entries(u)) {
    for (const [p, val] of Object.entries(fields)) {
      switch (op) {
        case '$set': setPath(d, p, clone(val)); break;
        case '$unset': unsetPath(d, p); break;
        case '$inc': { const cur = get(d, p) || 0; setPath(d, p, cur + val); break; }
        case '$push': { const cur = get(d, p) || []; if (val && val.$each) cur.push(...clone(val.$each)); else cur.push(clone(val)); setPath(d, p, cur); break; }
        case '$max': { const cur = get(d, p); if (cur == null || val > cur) setPath(d, p, val); break; }
        default: throw new Error('Unsupported update operator ' + op);
      }
    }
  }
  return d;
}
function sortDocs(docs, sort) {
  if (!sort) return docs;
  const keys = Object.entries(sort);
  return docs.sort((a, b) => { for (const [k, dir] of keys) { const c = cmp(get(a, k), get(b, k)); if (c) return c * dir; } return 0; });
}
function project(doc, proj) {
  if (!proj) return doc;
  const inc = Object.entries(proj).filter(([, v]) => v).map(([k]) => k);
  if (inc.length) { const o = { _id: doc._id }; inc.forEach((k) => { const v = get(doc, k); if (v !== undefined) setPath(o, k, v); }); return o; }
  const o = clone(doc); Object.keys(proj).forEach((k) => unsetPath(o, k)); return o;
}
/** equality fields of a query, used to build the inserted doc on upsert */
function seedFromQuery(q) { const o = {}; for (const [k, v] of Object.entries(q)) if (k[0] !== '$' && (v === null || typeof v !== 'object')) setPath(o, k, v); return o; }
module.exports = { match, applyUpdate, sortDocs, project, clone, get, seedFromQuery };
