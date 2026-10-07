'use strict';
/** Tiny input validator (no extra dependency). Each helper throws BadRequest with a readable message. */
const { BadRequest } = require('./errors');
const str = (v, name, { min = 0, max = 200, required = false, pattern } = {}) => {
  if (v == null || v === '') { if (required) throw new BadRequest(`${name} is required`); return ''; }
  if (typeof v !== 'string' && typeof v !== 'number') throw new BadRequest(`${name} is invalid`);
  const s = String(v).trim();
  if (required && !s) throw new BadRequest(`${name} is required`);
  if (s.length < min || s.length > max) throw new BadRequest(`${name} must be ${min}-${max} characters`);
  if (pattern && s && !pattern.test(s)) throw new BadRequest(`${name} is invalid`);
  return s;
};
const int = (v, name, { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, def } = {}) => {
  if ((v == null || v === '') && def !== undefined) return def;
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (!Number.isSafeInteger(n)) throw new BadRequest(`${name} must be a whole number`);
  if (n < min || n > max) throw new BadRequest(`${name} must be between ${min} and ${max}`);
  return n;
};
const bool = (v, def = false) => (v == null ? def : v === true || v === 'true' || v === 1 || v === '1');
const oneOf = (v, name, list, def) => {
  if ((v == null || v === '') && def !== undefined) return def;
  if (!list.includes(v)) throw new BadRequest(`${name} must be one of ${list.join(', ')}`);
  return v;
};
const id = (v, name = 'id') => str(v, name, { required: true, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
const mobile = (v) => { const s = str(v, 'Mobile', { max: 15 }); if (s && !/^\+?\d{10,13}$/.test(s.replace(/[\s-]/g, ''))) throw new BadRequest('Mobile must be 10-13 digits'); return s.replace(/[\s-]/g, ''); };
const gstin = (v) => { const s = str(v, 'GSTIN', { max: 15 }).toUpperCase(); if (s && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(s)) throw new BadRequest('GSTIN format is invalid'); return s; };
/** escape user text for use inside a RegExp search */
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
module.exports = { str, int, bool, oneOf, id, mobile, gstin, rx };
