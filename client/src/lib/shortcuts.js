/**
 * ONE central keyboard shortcut registry.
 * Keys follow the Sale Entry key bar: F1 customer, F2 product, F4 payment, F6 hold, F7 recall, End then Enter = save & print.
 * The single-letter v2 keys are kept: C capture, A add, S save, M manual weight, N next product, P product.
 * Single letters only fire when the cursor is NOT in a text field. F-keys / Ctrl / Alt combos work everywhere.
 * Manager can override keys in Settings > Shortcuts (stored server-side, applied to all counters).
 */
export const ACTIONS = {
  customerSearch: { label: 'Customer', keys: ['F1'] },
  productSearch: { label: 'Product', keys: ['F2', 'Ctrl+F', 'P'] },
  newBill: { label: 'New bill', keys: ['F3', 'Ctrl+N'] },
  payment: { label: 'Payment', keys: ['F4'] },
  addItem: { label: 'Add item', keys: ['F5', 'A'] },
  held: { label: 'Hold bill', keys: ['F6'] },
  recall: { label: 'Recall held bill', keys: ['F7'] },
  capture: { label: 'Capture weight', keys: ['F8', 'C'] },
  save: { label: 'Save bill (cash, exact)', keys: ['F9', 'Ctrl+S', 'S'] },
  discount: { label: 'Discount', keys: ['F10'] },
  print: { label: 'Print last', keys: ['F11', 'Ctrl+P'] },
  items: { label: 'All items / stock', keys: ['F12'] },
  complete: { label: 'Complete bill', keys: ['Ctrl+Enter'] },
  finalize: { label: 'Go to Save & Print (then Enter)', keys: ['End'] },
  manualWeight: { label: 'Manual weight', keys: ['M', 'Alt+W'] },
  rate: { label: 'Rate', keys: ['Alt+R'] },
  quantity: { label: 'Quantity', keys: ['Alt+Q'] },
  nextProduct: { label: 'Next product', keys: ['N'] },
  history: { label: 'Bill history', keys: ['Ctrl+H'] },
  refresh: { label: 'Refresh data', keys: ['Ctrl+R'] },
  deleteLine: { label: 'Delete line', keys: ['Delete'] },
};
let overrides = {};
export const setOverrides = (o) => { overrides = o || {}; };
export const keysOf = (a) => (overrides[a] ? [overrides[a]] : ACTIONS[a].keys);
export const hint = (a) => keysOf(a)[0];
export function comboOf(e) {
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && k.length > 1 ? 'Shift+' : '') + k;
}
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
let stack = []; // active scopes; the top-most handles keys (modal over POS)
/** register a scope: handlers = {action: fn}. Returns unregister. */
export function pushScope(handlers) { const s = { handlers }; stack.push(s); return () => { stack = stack.filter((x) => x !== s); }; }
window.addEventListener('keydown', (e) => {
  if (e.repeat && !['ArrowUp', 'ArrowDown'].includes(e.key)) { if (/^F\d+$/.test(e.key)) e.preventDefault(); return; }
  const top = stack[stack.length - 1]; if (!top) return;
  const combo = comboOf(e);
  for (const [a, fn] of Object.entries(top.handlers)) {
    if (!ACTIONS[a]) continue;
    for (const k of keysOf(a)) {
      if (k !== combo) continue;
      const single = k.length === 1;
      if ((single || k === 'Delete') && typing(e.target)) continue;  // letters/Delete never steal typing
      e.preventDefault(); e.stopPropagation(); fn(e); return;
    }
  }
  if (/^F\d+$/.test(e.key) || ['Ctrl+P', 'Ctrl+R', 'Ctrl+S', 'Ctrl+F', 'Ctrl+H', 'Ctrl+N'].includes(combo)) e.preventDefault(); // block browser defaults
}, true);
