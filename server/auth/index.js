'use strict';
/**
 * Authentication & request identity.
 *  - users log in with username + password OR 4-6 digit PIN
 *  - JWT carries a session id; sessions live in DB so logout / disabling a user takes effect immediately
 *  - failed attempts are persisted (lockout survives restarts)
 *  - terminal identity is decided by the SERVER: the counter PC's local service adds a secret terminal key header;
 *    the browser/renderer can never choose which counter it is.
 *  - approvals: a manager types username + PIN on the operator's screen; server returns a 2-minute approval token
 *    bound to one action (discount / manual weight / rate change / cancel ...).
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { can, permsOf, RANK } = require('./rbac');
const { Unauthorized, Forbidden, BadRequest, ApprovalRequired } = require('../lib/errors');
const { token, sha256, uuid } = require('../lib/ids');
const settings = require('../services/settings');
const { audit } = require('../services/audit');
const cfg = require('../config');

let SECRET = null;
async function initSecret() {
  let s = await db.c.settings.findOne({ _id: 'secret' });
  if (!s) { s = { _id: 'secret', v: token(48) }; await db.c.settings.insert(s); }
  SECRET = s.v;
}
const secret = () => { if (!SECRET) throw new Error('auth not initialised'); return SECRET; };

const MAX_FAILS = 5, LOCK_MS = 5 * 60000;
const isPin = (s) => /^\d{4,6}$/.test(s);
function checkSecret(u, pw) {
  if (!pw) return false;
  if (u.pass && bcrypt.compareSync(pw, u.pass)) return true;
  if (u.pinHash && isPin(pw) && bcrypt.compareSync(pw, u.pinHash)) return true;
  return false;
}
async function verifyUser(username, pw) {
  const un = String(username || '').trim().toLowerCase();
  if (!un || !pw) throw new BadRequest('Enter username and password / PIN');
  const u = await db.c.users.findOne({ username: un });
  if (u && u.lockedUntil && u.lockedUntil > Date.now()) throw new Unauthorized(`Too many wrong attempts. Try again in ${Math.ceil((u.lockedUntil - Date.now()) / 60000)} min.`);
  if (!u || !u.active || !checkSecret(u, String(pw))) {
    if (u) {
      const fails = (u.failedLogins || 0) + 1;
      await db.c.users.update({ _id: u._id }, { $set: { failedLogins: fails >= MAX_FAILS ? 0 : fails, lockedUntil: fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0 } });
    }
    return null;
  }
  if (u.failedLogins || u.lockedUntil) await db.c.users.update({ _id: u._id }, { $set: { failedLogins: 0, lockedUntil: 0 } });
  return u;
}
const publicUser = (u) => ({ id: u._id, username: u.username, name: u.name, role: u.role, perms: permsOf(u.role) });

async function login(req, username, pw) {
  const u = await verifyUser(username, pw);
  const ctx = { terminal: req.terminal, ip: req.ip };
  if (!u) { await audit({ ...ctx, user: { username: String(username || '').toLowerCase() } }, 'LOGIN_FAILED', { entity: 'user' }); throw new Unauthorized('Wrong username or password / PIN'); }
  const sid = uuid();
  await db.c.sessions.insert({ _id: sid, userId: u._id, username: u.username, role: u.role, terminalId: req.terminal ? req.terminal._id : null, terminalCode: req.terminal ? req.terminal.code : '', loginAt: new Date().toISOString(), logoutAt: null, active: true, ip: req.ip || '' });
  if (req.terminal) await db.c.terminals.update({ _id: req.terminal._id }, { $set: { currentUser: u.username, currentSession: sid } });
  await audit({ ...ctx, user: u }, 'LOGIN', { entity: 'session', entityId: sid });
  const t = jwt.sign({ sid, uid: u._id, username: u.username, role: u.role, name: u.name }, secret(), { expiresIn: '14h' });
  return { token: t, user: publicUser(u) };
}
async function logout(req) {
  if (!req.session) return;
  await db.c.sessions.update({ _id: req.session.sid }, { $set: { active: false, logoutAt: new Date().toISOString() } });
  sessionCache.delete(req.session.sid);
  if (req.terminal) await db.c.terminals.update({ _id: req.terminal._id, currentSession: req.session.sid }, { $set: { currentUser: '', currentSession: '' } });
  await audit(req, 'LOGOUT', { entity: 'session', entityId: req.session.sid });
}

const sessionCache = new Map(); // sid -> {ok, exp}
async function sessionActive(sid) {
  const c = sessionCache.get(sid);
  if (c && c.exp > Date.now()) return c.user;
  const s = await db.c.sessions.findOne({ _id: sid });
  let user = null;
  if (s && s.active) { const u = await db.c.users.findOne({ _id: s.userId }); if (u && u.active) user = u; }
  sessionCache.set(sid, { user, exp: Date.now() + 15000 });
  return user;
}
const dropUserSessions = (userId) => { for (const [k, v] of sessionCache) if (v.user && v.user._id === userId) sessionCache.delete(k); };

/** middleware: requires a logged-in user; optional permission */
const requireAuth = (perm) => async (req, res, next) => {
  try {
    const h = req.headers.authorization || '';
    const raw = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!raw) throw new Unauthorized();
    let p; try { p = jwt.verify(raw, secret()); } catch (e) { throw new Unauthorized('Session expired. Please login again.'); }
    const u = await sessionActive(p.sid);
    if (!u) throw new Unauthorized('Session ended. Please login again.');
    req.session = p;
    req.user = { id: u._id, _id: u._id, username: u.username, role: u.role, name: u.name };
    if (perm && !can(u.role, perm)) throw new Forbidden();
    next();
  } catch (e) { next(e); }
};

/* ---------- terminal identity ---------- */
const isLoopback = (a = '') => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const termCache = new Map();
async function terminalByKey(key) {
  const h = sha256(key);
  const c = termCache.get(h);
  if (c && c.exp > Date.now()) return c.t;
  const t = await db.c.terminals.findOne({ keyHash: h, active: true });
  termCache.set(h, { t, exp: Date.now() + 15000 });
  return t;
}
const clearTerminalCache = () => termCache.clear();
let localTerminal = null;
async function ensureLocalTerminal() {
  if (cfg.mode === 'terminal') return null;
  let t = await db.c.terminals.findOne({ code: cfg.localTerminalCode });
  if (!t) t = await db.c.terminals.insert({ code: cfg.localTerminalCode, name: cfg.mode === 'standalone' ? 'This PC' : 'Manager PC', series: legacySeries(), active: true, local: true, scaleSecret: token(32), createdAt: new Date().toISOString(), print: { paper: '80mm', copies: 1, printer: '' } });
  localTerminal = t; return t;
}
/** the legacy app numbered bills with COUNTER_ID (C1...). Keep that series for this PC so numbering continues. */
const legacySeries = () => ((process.env.COUNTER_ID || 'C1').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'C1');
const resolveTerminal = async (req, res, next) => {
  try {
    const key = req.headers['x-terminal-key'];
    if (key) {
      const t = await terminalByKey(String(key));
      if (!t) throw new Unauthorized('This counter is not registered or was disabled. Ask the manager.');
      req.terminal = t;
    } else if (isLoopback(req.socket && req.socket.remoteAddress) && localTerminal) {
      req.terminal = await db.c.terminals.findOne({ _id: localTerminal._id });
    } else req.terminal = null; // browser on the LAN: can view reports, cannot bill
    next();
  } catch (e) { next(e); }
};

/* ---------- approvals (manager PIN) ---------- */
async function approve(req, { username, secret: pw, action, value }) {
  const u = await verifyUser(username, pw);
  if (!u) { await audit(req, 'APPROVAL_FAILED', { detail: `${username} ${action}` }); throw new Unauthorized('Wrong approver username or PIN'); }
  const ok = await approverAllowed(u, action, value);
  if (!ok) throw new Forbidden(`${u.username} cannot approve this`);
  const t = jwt.sign({ typ: 'approval', uid: u._id, username: u.username, role: u.role, action, value: value == null ? null : value }, secret(), { expiresIn: '3m' });
  return { approval: t, approver: u.username };
}
async function approverAllowed(u, action, value) {
  const { P } = require('./rbac');
  if (action === 'discount') { const lim = (await settings.get()).discountLimits[u.role] || 0; return can(u.role, P.DISCOUNT) && (value == null || lim >= value); }
  const map = { weight_manual: P.WEIGHT_MANUAL, rate_override: P.RATE_OVERRIDE, bill_cancel: P.BILL_CANCEL, bill_return: P.BILL_RETURN, reprint: P.BILL_REPRINT, credit_limit: P.CUSTOMER_EDIT, line_delete: P.BILL_CANCEL, resume_any: P.BILL_RESUME_ANY };
  return !!map[action] && can(u.role, map[action]) && RANK[u.role] >= RANK.MANAGER;
}
/** returns approver username if token valid for action, else null */
function checkApproval(tok, action, value) {
  if (!tok) return null;
  try {
    const p = jwt.verify(tok, secret());
    if (p.typ !== 'approval' || p.action !== action) return null;
    if (action === 'discount' && value != null && p.value != null && value > p.value) return null;
    return p.username;
  } catch (e) { return null; }
}
/** user may do it themselves, or a valid approval token must be supplied */
function needs(req, perm, action, approvalTok, value, message) {
  if (can(req.user.role, perm)) return req.user.username;
  const a = checkApproval(approvalTok, action, value);
  if (a) return a;
  throw new ApprovalRequired(message || 'Manager approval required', action, { value });
}

module.exports = { initSecret, login, logout, requireAuth, resolveTerminal, ensureLocalTerminal, approve, checkApproval, needs, publicUser, verifyUser, dropUserSessions, clearTerminalCache, legacySeries, isPin, getLocalTerminal: () => localTerminal };
