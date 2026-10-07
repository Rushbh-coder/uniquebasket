/** Formatting & parsing with integers only (paise, grams). Never parse money through floats. */
export const WEIGHED = { KG: 1000, LITRE: 1000 };
export const isWeighed = (u) => !!WEIGHED[u];
export const rs = (p) => (p < 0 ? '-' : '') + (Math.abs(p || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const qtyStr = (u, n) => (isWeighed(u) ? (n / 1000).toFixed(3) : String(n));
export const unitLabel = (u) => ({ KG: 'kg', LITRE: 'L', PCS: 'pcs', DOZEN: 'dz', BOX: 'box', BAG: 'bag', CRATE: 'crate', BUNDLE: 'bdl' }[u] || u);
/** "590.4" -> 59040 ; returns NaN for invalid */
export function parseFixed(s, decimals) {
  const t = String(s ?? '').trim().replace(/,/g, '');
  if (!t) return NaN;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(t); if (!m || (!m[2] && !m[3])) return NaN;
  const frac = (m[3] || '').padEnd(decimals, '0');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return NaN;
  const n = Number((m[2] || '0') + frac.slice(0, decimals));
  return m[1] ? -n : n;
}
export const paise = (s) => parseFixed(s, 2);
export const milli = (s) => parseFixed(s, 3);
export const parseQty = (u, s) => (isWeighed(u) ? milli(s) : /^\d+$/.test(String(s).trim()) ? Number(s) : NaN);
export const divRound = (a, b) => { const sign = (a < 0) !== (b < 0) ? -1 : 1; const A = Math.abs(a), B = Math.abs(b); return sign * Math.floor((2 * A + B) / (2 * B)); };
/** same formula as the server (display only — server recalculates) */
export const lineAmount = (u, qty, rate) => divRound(qty * rate, WEIGHED[u] || 1);
export const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
export const tm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '');
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const pct = (bp) => (bp / 100).toFixed(2) + '%';
