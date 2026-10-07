'use strict';
/**
 * Real-time push to all PCs using Server-Sent Events (built into Node and every browser/Electron, auto-reconnects,
 * no extra dependency, proxies cleanly through the counter PC's local service).
 * Event names follow the spec: product:price-updated, bill:completed, terminal:online ...
 * Clients authenticate with a one-time ticket (no long-lived token in the URL).
 * After any reconnect the client re-fetches authoritative data, so a missed event can never leave a stale rate.
 */
const { token } = require('./lib/ids');
const clients = new Set();
const tickets = new Map(); // ticket -> {user, terminal, exp}
let seq = 0;

function issueTicket(user, terminal) {
  const t = token(18);
  tickets.set(t, { user, terminal, exp: Date.now() + 60000 });
  for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
  return t;
}
function takeTicket(t) { const v = tickets.get(t); tickets.delete(t); return v && v.exp > Date.now() ? v : null; }

/** audience: 'all' | 'managers' | {terminalId} | {userId} */
function emit(event, data, audience = 'all') {
  const msg = `id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (audience === 'managers' && !c.manager) continue;
    if (audience && audience.terminalId && c.terminalId !== audience.terminalId && !c.manager) continue;
    if (audience && audience.userId && c.userId !== audience.userId) continue;
    try { c.res.write(msg); } catch (e) { clients.delete(c); }
  }
}

function attach(req, res, who, onClose) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const c = { res, ...who };
  clients.add(c);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 15000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); onClose && onClose(c); });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  return c;
}
const stats = () => ({ clients: clients.size });
const connectedTerminals = () => new Set([...clients].map((c) => c.terminalId).filter(Boolean));
module.exports = { emit, attach, issueTicket, takeTicket, stats, connectedTerminals };
