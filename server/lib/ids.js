'use strict';
const crypto = require('crypto');
const uuid = () => crypto.randomUUID();
/** 24-hex id, same shape the legacy app used for _id */
const hexId = () => crypto.randomBytes(12).toString('hex');
const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
/** human friendly one-time code, no ambiguous chars */
function code(len = 8) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(len);
  return Array.from(b, (x) => A[x % A.length]).join('');
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(String(s)).digest('hex');
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
module.exports = { uuid, hexId, token, code, sha256, hmac, safeEqual };
