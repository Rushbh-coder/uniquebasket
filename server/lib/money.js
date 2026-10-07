'use strict';
/**
 * Money & quantity helpers. ALL money is integer paise, ALL weighed quantities are integer milli-units
 * (grams for KG, ml for LITRE). Counted units (PCS, BOX, BAG ...) are integer counts.
 * Never use floating point for totals: every function here takes and returns integers.
 */
const { BadRequest } = require('./errors');

// unit -> how many stored units make 1 display unit
const UNITS = {
  KG: { scale: 1000, weighed: true, label: 'kg' },
  LITRE: { scale: 1000, weighed: true, label: 'L' },
  PCS: { scale: 1, weighed: false, label: 'pcs' },
  DOZEN: { scale: 1, weighed: false, label: 'dozen' },
  BOX: { scale: 1, weighed: false, label: 'box' },
  BAG: { scale: 1, weighed: false, label: 'bag' },
  CRATE: { scale: 1, weighed: false, label: 'crate' },
  BUNDLE: { scale: 1, weighed: false, label: 'bundle' },
};
const unitInfo = (u) => {
  const x = UNITS[u];
  if (!x) throw new BadRequest('Unknown unit ' + u);
  return x;
};

/** Integer division with half-up rounding (works for negatives symmetrically). */
function divRound(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b === 0) throw new Error('divRound needs integers');
  const sign = (a < 0) !== (b < 0) ? -1 : 1;
  const A = Math.abs(a), B = Math.abs(b);
  return sign * Math.floor((2 * A + B) / (2 * B));
}

/** amount (paise) = qty (stored units) * rate (paise per display unit) / scale */
function lineGross(unit, qty, rate) {
  const { scale } = unitInfo(unit);
  const p = qty * rate;
  if (!Number.isSafeInteger(p)) throw new BadRequest('Amount too large');
  return divRound(p, scale);
}

/**
 * Tax on a line. taxRate is in basis points (500 = 5%).
 * inclusive=true: amount already contains GST -> split it out.
 * inclusive=false: GST is added on top.
 */
function lineTax(net, taxRate, inclusive) {
  if (!taxRate) return { taxable: net, tax: 0, total: net };
  if (inclusive) {
    const taxable = divRound(net * 10000, 10000 + taxRate);
    return { taxable, tax: net - taxable, total: net };
  }
  const tax = divRound(net * taxRate, 10000);
  return { taxable: net, tax, total: net + tax };
}

/** Distribute `amount` over `weights` proportionally, exact to the paisa (largest remainder). */
function allocate(amount, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / sum);
  const out = raw.map(Math.floor);
  let rest = amount - out.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]]++;
  return out;
}

/** Round a total to the nearest `step` paise (100 = nearest rupee). */
function roundTo(total, step) {
  if (!step || step <= 1) return total;
  return divRound(total, step) * step;
}

const isInt = (v) => Number.isSafeInteger(v);
function toInt(v, name, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new BadRequest(`${name} is invalid`);
  return n;
}
const rupees = (p) => (p / 100).toFixed(2);

module.exports = { UNITS, unitInfo, divRound, lineGross, lineTax, allocate, roundTo, isInt, toInt, rupees };
