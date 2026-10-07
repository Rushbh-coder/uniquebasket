'use strict';
/** Counter PC registration. Manager creates a terminal -> one-time enrolment code -> counter PC exchanges it for a
 *  secret terminal key (stored only on that PC) + scale signing secret. */
const { db } = require('../db');
const v = require('../lib/validate');
const { BadRequest, NotFound, Conflict, Unauthorized } = require('../lib/errors');
const { code, token, sha256 } = require('../lib/ids');
const { audit } = require('./audit');
const auth = require('../auth');
const rt = require('../realtime');
const ONLINE_MS = 75000;
const view = (t) => {
  const connected = rt.connectedTerminals().has(t._id);
  const online = connected || (t.lastSeen && Date.now() - Date.parse(t.lastSeen) < ONLINE_MS);
  const { keyHash, scaleSecret, enrolCodeHash, ...rest } = t;
  return { ...rest, status: online ? 'ONLINE' : 'OFFLINE', enrolled: !!keyHash || !!t.local };
};
async function list() { return (await db.c.terminals.find({}, { sort: { code: 1 } })).map(view); }
function clean(b) {
  return {
    name: v.str(b.name, 'Terminal name', { required: true, max: 40 }),
    series: v.str(b.series, 'Bill series', { required: true, max: 4, pattern: /^[A-Z0-9]+$/ }),
    active: v.bool(b.active, true),
  };
}
async function create(req, b) {
  const c = v.str(b.code, 'Terminal ID', { required: true, max: 20, pattern: /^[A-Z0-9-]+$/ });
  const doc = clean(b);
  if (await db.c.terminals.findOne({ series: doc.series })) throw new Conflict('Bill series already used by another counter');
  const enrol = code(8);
  try {
    const t = await db.c.terminals.insert({ code: c, ...doc, enrolCodeHash: sha256(enrol), enrolExpires: Date.now() + 7 * 864e5, createdAt: new Date().toISOString(), print: { paper: '80mm', copies: 1, printer: '' }, scale: {} });
    await audit(req, 'TERMINAL_CREATED', { entity: 'terminal', entityId: t._id, new: { code: c, series: doc.series } });
    return { terminal: view(t), enrolCode: enrol };
  } catch (e) { if (e.duplicateKey) throw new Conflict('Terminal ID already exists'); throw e; }
}
async function update(req, id, b) {
  const cur = await db.c.terminals.findOne({ _id: id }); if (!cur) throw new NotFound('Terminal not found');
  const doc = clean({ ...cur, ...b });
  if (doc.series !== cur.series) {
    if (await db.c.bills.findOne({ terminalId: id })) throw new BadRequest('Bill series cannot change after bills were made on this counter');
    if (await db.c.terminals.findOne({ series: doc.series, _id: { $ne: id } })) throw new Conflict('Bill series already used');
  }
  const print = b.print && typeof b.print === 'object' ? { paper: v.oneOf(b.print.paper, 'Paper', ['58mm', '80mm', 'A4'], '80mm'), copies: v.int(b.print.copies, 'Copies', { min: 1, max: 5, def: 1 }), printer: v.str(b.print.printer, 'Printer', { max: 120 }) } : cur.print;
  await db.c.terminals.update({ _id: id }, { $set: { ...doc, print } });
  auth.clearTerminalCache();
  await audit(req, doc.active === cur.active ? 'TERMINAL_UPDATED' : doc.active ? 'TERMINAL_ENABLED' : 'TERMINAL_DISABLED', { entity: 'terminal', entityId: id, old: { name: cur.name, active: cur.active, print: cur.print }, new: { name: doc.name, active: doc.active, print } });
  return view(await db.c.terminals.findOne({ _id: id }));
}
async function newEnrolCode(req, id) {
  const t = await db.c.terminals.findOne({ _id: id }); if (!t || t.local) throw new NotFound('Terminal not found');
  const enrol = code(8);
  await db.c.terminals.update({ _id: id }, { $set: { enrolCodeHash: sha256(enrol), enrolExpires: Date.now() + 7 * 864e5 }, $unset: { keyHash: 1 } });
  auth.clearTerminalCache();
  await audit(req, 'TERMINAL_REENROL', { entity: 'terminal', entityId: id, detail: t.code });
  return { enrolCode: enrol };
}
/** called (unauthenticated) by a counter PC's setup screen */
async function enrol(b, ip) {
  const c = v.str(b.enrolCode, 'Enrolment code', { required: true, max: 12 }).toUpperCase();
  const t = await db.c.terminals.findOne({ enrolCodeHash: sha256(c) });
  if (!t || !(t.enrolExpires > Date.now())) throw new Unauthorized('Enrolment code is wrong or expired. Ask the manager for a new code.');
  const key = token(32), scaleSecret = token(32);
  await db.c.terminals.update({ _id: t._id }, { $set: { keyHash: sha256(key), scaleSecret, machine: v.str(b.machine, 'Machine', { max: 60 }), enrolledAt: new Date().toISOString(), ip }, $unset: { enrolCodeHash: 1, enrolExpires: 1 } });
  auth.clearTerminalCache();
  await audit({ user: { username: 'system' }, ip }, 'TERMINAL_ENROLLED', { entity: 'terminal', entityId: t._id, detail: t.code });
  return { terminalKey: key, scaleSecret, code: t.code, name: t.name, series: t.series };
}
/** heartbeat from the counter's local service (every 30 s) */
async function heartbeat(req, b) {
  if (!req.terminal) return { ok: false };
  const s = b && typeof b === 'object' ? b : {};
  const set = { lastSeen: new Date().toISOString(), ip: req.ip || '', version: v.str(s.version, 'version', { max: 20 }),
    scaleStatus: v.str(s.scaleStatus, 'scale', { max: 40 }), printerStatus: v.str(s.printerStatus, 'printer', { max: 60 }), machine: v.str(s.machine, 'machine', { max: 60 }) || req.terminal.machine || '' };
  const was = req.terminal.lastSeen && Date.now() - Date.parse(req.terminal.lastSeen) < ONLINE_MS;
  await db.c.terminals.update({ _id: req.terminal._id }, { $set: set });
  if (!was) rt.emit('terminal:online', { code: req.terminal.code }, 'managers');
  return { ok: true, serverTime: set.lastSeen };
}
let watcher;
function watchOffline() {
  const seen = new Map();
  watcher = setInterval(async () => {
    try {
      for (const t of await db.c.terminals.find({ active: { $ne: false } })) {
        const on = view(t).status === 'ONLINE';
        if (seen.has(t._id) && seen.get(t._id) !== on) rt.emit(on ? 'terminal:online' : 'terminal:offline', { code: t.code }, 'managers');
        seen.set(t._id, on);
      }
    } catch (e) {}
  }, 20000);
  watcher.unref && watcher.unref();
}
module.exports = { list, create, update, newEnrolCode, enrol, heartbeat, view, watchOffline, stop: () => clearInterval(watcher) };
