/** Server-sent events with ticket auth + automatic reconnect. After every (re)connect `onSync` runs so the
 *  screen re-fetches authoritative data (prices, stock) — no missed update can leave a stale rate. */
import { post } from './api';
export function connectEvents({ onEvent, onStatus, onSync }) {
  let es = null, closed = false, retry = 1000, timer;
  const EVENTS = ['product:created', 'product:updated', 'product:price-updated', 'product:status-changed', 'product:price-scheduled', 'inventory:updated', 'bill:completed', 'bill:cancelled', 'bill:returned', 'bill:held', 'terminal:online', 'terminal:offline', 'user:permission-updated', 'settings:updated', 'customer:updated', 'customer:payment', 'purchase:created', 'shift:closed', 'data:restored'];
  async function open() {
    if (closed) return;
    try {
      const { ticket } = await post('/events/ticket');
      es = new EventSource('/api/events?ticket=' + encodeURIComponent(ticket));
      es.addEventListener('hello', () => { retry = 1000; onStatus(true); onSync && onSync(); });
      EVENTS.forEach((n) => es.addEventListener(n, (e) => { try { onEvent(n, JSON.parse(e.data)); } catch (x) {} }));
      es.onerror = () => { onStatus(false); es.close(); schedule(); };
    } catch (e) { onStatus(false); if (e.status !== 401) schedule(); }
  }
  const schedule = () => { clearTimeout(timer); if (!closed) timer = setTimeout(open, retry); retry = Math.min(retry * 2, 15000); };
  open();
  return () => { closed = true; clearTimeout(timer); es && es.close(); };
}
export function connectScale(onState) {
  let es = null, closed = false, timer;
  async function open() {
    if (closed) return;
    try {
      const { ticket } = await post('/scale/ticket');
      es = new EventSource('/api/scale/stream?ticket=' + encodeURIComponent(ticket));
      es.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch (x) {} };
      es.onerror = () => { es.close(); onState({ connected: false, error: 'Scale service not reachable', grams: 0, stable: false }); timer = setTimeout(open, 3000); };
    } catch (e) { timer = setTimeout(open, 3000); }
  }
  open();
  return () => { closed = true; clearTimeout(timer); es && es.close(); };
}
