'use strict';
/** Scale readings are signed by the PC the scale is plugged into (HMAC with that terminal's scale secret).
 *  The server only accepts a line as "SCALE" if the signature matches — typed weights are always "MANUAL". */
const { hmac, safeEqual } = require('./ids');
const payload = (r) => `${r.grams}|${r.at}|${r.terminal}|${r.mock ? 1 : 0}`;
const sign = (secret, r) => ({ ...r, sig: hmac(secret, payload(r)) });
function verify(secret, r, terminalCode, maxAgeMs = 12 * 3600e3) {
  if (!secret || !r || typeof r.sig !== 'string') return false;
  if (r.terminal !== terminalCode) return false;
  const age = Date.now() - Date.parse(r.at);
  if (!(age >= -60000 && age <= maxAgeMs)) return false;
  return safeEqual(r.sig, hmac(secret, payload(r)));
}
module.exports = { sign, verify };
