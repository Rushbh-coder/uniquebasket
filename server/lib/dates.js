'use strict';
/** Business dates are always computed in the shop's time zone (default Asia/Kolkata), never UTC. */
const TZ = process.env.SHOP_TZ || 'Asia/Kolkata';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD in shop time zone */
const businessDate = (d = new Date()) => fmt.format(d instanceof Date ? d : new Date(d));
/** Indian financial year label, e.g. 2026-27 (April-March) */
function financialYear(d = new Date()) {
  const [y, m] = businessDate(d).split('-').map(Number);
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String(s + 1).slice(2)}`;
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
module.exports = { TZ, businessDate, financialYear, isDate };
