/** Mirror of server/lib/money.js for the live on-screen total. The server recalculates and is authoritative. */
import { divRound, lineAmount } from './fmt';
function allocate(amount, weights) {
  const sum = weights.reduce((s, w) => s + w, 0); if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / sum); const out = raw.map(Math.floor);
  let rest = amount - out.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]]++;
  return out;
}
export function totals(lines, discount, conf, taxOf) {
  const gross = lines.map((l) => lineAmount(l.unit, l.qty, l.rate));
  const sub = gross.reduce((s, x) => s + x, 0);
  let disc = 0;
  if (discount && discount.value) disc = discount.type === 'PCT' ? divRound(sub * discount.value, 10000) : Math.min(discount.value, sub);
  const ld = allocate(disc, gross);
  let tax = 0, total = 0;
  const lt = lines.map(() => 0); // tax per line, for the grid
  lines.forEach((l, i) => {
    const net = gross[i] - ld[i], r = taxOf(l.productId) || 0;
    if (!r) { total += net; return; }
    if (conf.priceIncludesTax) { const taxable = divRound(net * 10000, 10000 + r); lt[i] = net - taxable; tax += lt[i]; total += net; }
    else { const t = divRound(net * r, 10000); lt[i] = t; tax += t; total += net + t; }
  });
  const step = conf.roundStep || 1;
  const rounded = step > 1 ? divRound(total, step) * step : total;
  return { sub, discount: disc, discBp: sub ? Math.ceil((disc * 10000) / sub) : 0, tax, roundOff: rounded - total, total: rounded, gross, ld, lt };
}
