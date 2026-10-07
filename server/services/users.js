'use strict';
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const v = require('../lib/validate');
const { BadRequest, NotFound, Conflict, Forbidden } = require('../lib/errors');
const { ROLES, RANK } = require('../auth/rbac');
const { audit } = require('./audit');
const auth = require('../auth');
const rt = require('../realtime');
const view = ({ pass, pinHash, failedLogins, lockedUntil, ...u }) => ({ ...u, hasPin: !!pinHash, locked: !!(lockedUntil && lockedUntil > Date.now()) });
async function list() { return (await db.c.users.find({}, { sort: { username: 1 } })).map(view); }
function guardRank(req, role) { if ((RANK[role] || 0) > (RANK[req.user.role] || 0)) throw new Forbidden('You cannot manage a user with a higher role'); }
function pw(p, required) {
  const s = p == null ? '' : String(p);
  if (!s && !required) return null;
  if (s.length < 8 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) throw new BadRequest('Password must be at least 8 characters with letters and numbers');
  return bcrypt.hashSync(s, 10);
}
function pin(p) { const s = p == null ? '' : String(p); if (!s) return null; if (!auth.isPin(s)) throw new BadRequest('PIN must be 4-6 digits'); return bcrypt.hashSync(s, 10); }
async function create(req, b) {
  const username = v.str(b.username, 'Username', { required: true, min: 3, max: 30, pattern: /^[a-z0-9._-]+$/i }).toLowerCase();
  const role = v.oneOf(b.role, 'Role', Object.keys(ROLES));
  guardRank(req, role);
  const doc = { username, name: v.str(b.name, 'Name', { max: 60 }) || username, role, pass: pw(b.password, true), active: true, createdAt: new Date().toISOString(), createdBy: req.user.username };
  const ph = pin(b.pin); if (ph) doc.pinHash = ph;
  try { const u = await db.c.users.insert(doc); await audit(req, 'USER_CREATED', { entity: 'user', entityId: u._id, new: { username, role } }); return view(u); }
  catch (e) { if (e.duplicateKey) throw new Conflict('Username already exists'); throw e; }
}
async function update(req, id, b) {
  const u = await db.c.users.findOne({ _id: id }); if (!u) throw new NotFound('User not found');
  guardRank(req, u.role);
  const set = {};
  if (b.name != null) set.name = v.str(b.name, 'Name', { max: 60 });
  if (b.role != null && b.role !== u.role) { set.role = v.oneOf(b.role, 'Role', Object.keys(ROLES)); guardRank(req, set.role); if (u._id === req.user.id) throw new BadRequest('You cannot change your own role'); }
  if (b.active != null) { set.active = v.bool(b.active); if (!set.active && u._id === req.user.id) throw new BadRequest('You cannot disable yourself'); }
  if (b.password) set.pass = pw(b.password, true);
  if (b.pin) set.pinHash = pin(b.pin);
  if (b.unlock) { set.failedLogins = 0; set.lockedUntil = 0; }
  if (set.active === false || set.role || set.pass) { await db.c.sessions.update({ userId: id, active: true }, { $set: { active: false, logoutAt: new Date().toISOString(), endedBy: req.user.username } }, { multi: true }); auth.dropUserSessions(id); }
  await db.c.users.update({ _id: id }, { $set: set });
  const changed = Object.keys(set).map((k) => (k === 'pass' ? 'password' : k === 'pinHash' ? 'pin' : k));
  await audit(req, set.role ? 'PERMISSION_CHANGED' : 'USER_UPDATED', { entity: 'user', entityId: id, old: { role: u.role, active: u.active }, new: { role: set.role || u.role, active: set.active == null ? u.active : set.active }, detail: changed.join(',') });
  if (set.role || set.active === false) rt.emit('user:permission-updated', { userId: id }, { userId: id });
  return view(await db.c.users.findOne({ _id: id }));
}
async function changeOwn(req, b) {
  const u = await auth.verifyUser(req.user.username, b.current);
  if (!u) throw new BadRequest('Current password is wrong');
  const set = {}; if (b.password) set.pass = pw(b.password, true); if (b.pin) set.pinHash = pin(b.pin);
  if (!Object.keys(set).length) throw new BadRequest('Nothing to change');
  await db.c.users.update({ _id: u._id }, { $set: set });
  await audit(req, 'OWN_PASSWORD_CHANGED', { entity: 'user', entityId: u._id, detail: Object.keys(set).join(',') });
  return { ok: true };
}
module.exports = { list, create, update, changeOwn, view };
