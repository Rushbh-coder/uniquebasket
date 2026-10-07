'use strict';
/**
 * Local service started by Electron on every PC (or by `node cloud.js` / `npm run server` without Electron).
 * Modes (chosen in PC Setup):
 *   server     - Manager PC / shop server: owns the database, serves the LAN on :4310. Database = built-in files on this
 *                PC when MONGO_URI is empty (no internet, nothing to install), else MongoDB (local or Atlas).
 *   standalone - single PC with local NeDB files (no network), same features
 *   terminal   - counter PC: NO database, NO credentials. Serves the screens + this PC's scale on 127.0.0.1 and
 *                forwards every other /api call to the shop server, adding this counter's secret terminal key.
 */
const express = require('express');
const path = require('path');
const http = require('http'), https = require('https');
const cfg = require('./config');
const log = require('./lib/log');
const { AppError } = require('./lib/errors');
const { Scale } = require('./hardware/scale');
const os = require('os');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); next(); });

/* small per-IP rate limit for login / approval endpoints */
const hits = new Map();
function limit(max, ms) { return (req, res, next) => { const k = req.ip + req.path; const now = Date.now(); const x = (hits.get(k) || []).filter((t) => now - t < ms); x.push(now); hits.set(k, x); if (x.length > max) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' }); next(); }; }

let scale = null, server = null;
const timers = [];

function errorHandler(err, req, res, next) {
  if (res.headersSent) return;
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  if (err instanceof AppError || (err && err.expose && err.status)) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra ? { extra: err.extra } : {}) });
  log.error(`${req.method} ${req.originalUrl}`, err);
  const billing = /^\/api\/(bills|held)/.test(req.originalUrl) && req.method !== 'GET';
  res.status(500).json({ error: billing ? 'Unable to save bill. No data has been committed.' : 'Something went wrong. Please try again.', code: 'SERVER_ERROR' });
}

/* ---------------- terminal mode: forward to shop server ---------------- */
function forward(req, res) {
  const u = new URL(cfg.serverUrl);
  const lib = u.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: u.host, 'x-terminal-key': cfg.terminalKey };
  delete headers['x-forwarded-for'];
  const body = req._body ? JSON.stringify(req.body) : null; // already parsed by express.json -> re-send exactly
  if (body != null) { headers['content-length'] = Buffer.byteLength(body); headers['content-type'] = 'application/json'; delete headers['transfer-encoding']; }
  const p = lib.request({ hostname: u.hostname, port: u.port || undefined, path: req.originalUrl, method: req.method, headers, timeout: req.originalUrl.startsWith('/api/events') ? 0 : 20000 }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('timeout', () => p.destroy(new Error('timeout')));
  p.on('error', () => { if (!res.headersSent) res.status(503).json({ error: 'Server connection lost. Check the network / manager PC.', code: 'SERVER_DOWN' }); else res.end(); });
  if (body != null) p.end(body); else req.pipe(p);
}
function remoteFetch(pth, opts = {}) {
  return fetch(cfg.serverUrl + pth, { ...opts, headers: { 'Content-Type': 'application/json', 'x-terminal-key': cfg.terminalKey, ...(opts.headers || {}) }, signal: AbortSignal.timeout(8000) });
}
const tokenCache = new Map();
async function remoteIdentify(req) {
  const t = (req.headers.authorization || '').slice(7);
  if (!t) throw new (require('./lib/errors').Unauthorized)();
  const c = tokenCache.get(t); if (c && c.exp > Date.now()) return c.u;
  const r = await remoteFetch('/api/me', { headers: { Authorization: 'Bearer ' + t } }).catch(() => null);
  if (!r) throw new AppError('Server connection lost.', 503, 'SERVER_DOWN');
  if (!r.ok) throw new (require('./lib/errors').Unauthorized)();
  const u = await r.json(); tokenCache.set(t, { u, exp: Date.now() + 60000 }); return u;
}

async function start(port = cfg.port, host) {
  log.init(path.join(cfg.dataDir, 'logs'));
  host = host || (cfg.mode === 'server' ? '0.0.0.0' : '127.0.0.1');
  if (cfg.mode === 'terminal') {
    if (!cfg.serverUrl || !cfg.terminalKey) throw new Error('Counter PC is not enrolled. Run PC Setup again.');
    scale = new Scale({ dataDir: cfg.dataDir, terminal: cfg.terminalCode, secret: process.env.SCALE_SECRET || '' });
    await scale.apply();
    app.use('/api', express.json({ limit: '1mb' }), require('./routes/local')({ scale, identify: remoteIdentify }));
    app.use('/api', (req, res, next) => { delete req.headers['x-terminal-key']; next(); }, forward);
    const beat = async () => { try { await remoteFetch('/api/terminals/heartbeat', { method: 'POST', body: JSON.stringify({ version: cfg.version, machine: os.hostname(), scaleStatus: scale.state.connected ? 'CONNECTED' : 'DISCONNECTED' + (scale.state.error ? ': ' + scale.state.error : ''), printerStatus: process.env.PRINTER_STATUS || '' }) }); } catch (e) {} };
    beat(); timers.push(setInterval(beat, 30000));
  } else {
    const { connect } = require('./db');
    await connect({ memory: cfg.memory, mongoUri: cfg.mongoUri, mongoDb: cfg.mongoDb, dataDir: cfg.dataDir });
    const auth = require('./auth');
    await auth.initSecret();
    await require('./db/seed').seed();
    const local = await auth.ensureLocalTerminal();
    scale = new Scale({ dataDir: cfg.dataDir, terminal: local.code, secret: local.scaleSecret });
    await scale.apply();
    const identify = (req) => new Promise((res, rej) => auth.requireAuth()(req, {}, (e) => (e ? rej(e) : res(req.user))));
    app.use('/api', express.json({ limit: '1mb' }));
    app.use('/api/login', limit(20, 60000)); app.use('/api/approve', limit(20, 60000)); app.use('/api/terminals/enrol', limit(10, 60000));
    app.use('/api', auth.resolveTerminal);
    app.use('/api', require('./routes/local')({ scale, identify }));
    app.use('/api', require('./routes/api'));
    require('./services/products').startScheduler();
    require('./services/backup').schedule();
    require('./services/terminals').watchOffline();
    const { db } = require('./db');
    const beat = () => db.c.terminals.update({ _id: local._id }, { $set: { lastSeen: new Date().toISOString(), version: cfg.version, machine: os.hostname(), scaleStatus: scale.state.connected ? 'CONNECTED' : 'DISCONNECTED' } }).catch(() => {});
    beat(); timers.push(setInterval(beat, 30000));
  }
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  const dist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  timers.forEach((t) => t.unref && t.unref());
  return new Promise((resolve, reject) => { server = app.listen(port, host, () => resolve(server.address().port)); server.on('error', reject); });
}
async function stop() { timers.forEach(clearInterval); try { require('./services/products').stopScheduler(); require('./services/backup').stop(); require('./services/terminals').stop(); } catch (e) {} if (scale) scale.disconnect(); if (server) await new Promise((r) => server.close(r));
  try { const { db } = require('./db'); if (db.kind === 'nedb') await db.store.close(); } catch (e) {} // built-in file database: stop its timers
}
async function resetAdmin(pw) {
  const bcrypt = require('bcryptjs');
  if (!pw || pw.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');
  const { connect, db } = require('./db');
  if (!db.kind) await connect({ mongoUri: cfg.mongoUri, mongoDb: cfg.mongoDb, dataDir: cfg.dataDir });
  const u = await db.c.users.findOne({ username: 'manager' });
  if (u) await db.c.users.update({ _id: u._id }, { $set: { pass: bcrypt.hashSync(pw, 10), active: true, role: 'OWNER', failedLogins: 0, lockedUntil: 0 } });
  else await db.c.users.insert({ username: 'manager', name: 'Owner', role: 'OWNER', pass: bcrypt.hashSync(pw, 10), active: true });
}
module.exports = { start, stop, resetAdmin, app, getScale: () => scale };
if (require.main === module) start().then((p) => console.log(`Billing service (${cfg.mode}) on http://127.0.0.1:${p}`)).catch((e) => { console.error('START FAILED:', e.message); process.exit(1); });
