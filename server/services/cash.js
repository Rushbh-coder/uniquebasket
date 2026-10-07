'use strict';
/** Cash shift per operator per counter: opening cash -> expected cash -> actual cash -> difference. */
const { db, tx } = require('../db');
const v = require('../lib/validate');
const { BadRequest, NotFound, Conflict, Forbidden } = require('../lib/errors');
const { audit } = require('./audit');
const rt = require('../realtime');
async function current(req) {
  if (!req.terminal) return null;
  return db.c.cash_sessions.findOne({ terminalId: req.terminal._id, userId: req.user.id, status: 'OPEN' });
}
async function open(req, b) {
  if (!req.terminal) throw new Forbidden('Open a shift from a counter PC');
  const openingCash = v.int(b.openingCash, 'Opening cash', { min: 0, max: 1e10 });
  return tx(async (t) => {
    if (await t.cash_sessions.findOne({ terminalId: req.terminal._id, userId: req.user.id, status: 'OPEN' })) throw new Conflict('A shift is already open on this counter');
    const s = await t.cash_sessions.insert({ terminalId: req.terminal._id, terminalCode: req.terminal.code, userId: req.user.id, username: req.user.username, openedAt: new Date().toISOString(), openingCash, status: 'OPEN' });
    await audit(req, 'SHIFT_OPEN', { entity: 'cash_session', entityId: s._id, new: openingCash }, t);
    return s;
  }, 'shift-open');
}
/** expected = opening + cash received on bills - change given ... computed from payments rows of this session */
async function expected(s, until) {
  const bills = await db.c.bills.find({ cashSessionId: s._id });
  let cashSales = 0, cancelledCash = 0;
  for (const b of bills) {
    const cash = (b.payments || []).filter((p) => p.mode === 'CASH').reduce((x, p) => x + p.amount, 0);
    cashSales += cash;
    if (b.status === 'CANCELLED') cancelledCash += cash;
  }
  const rets = await db.c.returns.find({ terminalId: s.terminalId, refundMode: 'CASH', at: { $gte: s.openedAt, $lte: until || new Date().toISOString() } });
  const cashRefunds = rets.filter((r) => r.by === s.username).reduce((x, r) => x + r.amount, 0);
  return { openingCash: s.openingCash, cashSales, cancelledCash, cashRefunds, expectedCash: s.openingCash + cashSales - cancelledCash - cashRefunds, bills: bills.length };
}
async function close(req, b) {
  const actualCash = v.int(b.actualCash, 'Actual cash', { min: 0, max: 1e10 });
  const note = v.str(b.note, 'Note', { max: 200 });
  const s = await current(req);
  if (!s) throw new NotFound('No open shift on this counter');
  const now = new Date().toISOString();
  const e = await expected(s, now);
  const r = await tx(async (t) => {
    await t.cash_sessions.update({ _id: s._id, status: 'OPEN' }, { $set: { status: 'CLOSED', closedAt: now, ...e, actualCash, difference: actualCash - e.expectedCash, note } });
    await audit(req, 'SHIFT_CLOSE', { entity: 'cash_session', entityId: s._id, new: { expected: e.expectedCash, actual: actualCash, difference: actualCash - e.expectedCash } }, t);
    return t.cash_sessions.findOne({ _id: s._id });
  }, 'shift-close');
  rt.emit('shift:closed', { terminalCode: s.terminalCode, username: s.username, difference: r.difference }, 'managers');
  return r;
}
async function list(q = {}) {
  const f = {}; if (q.from) f.openedAt = { $gte: q.from }; if (q.status) f.status = q.status;
  return db.c.cash_sessions.find(f, { sort: { openedAt: -1 }, limit: 200 });
}
module.exports = { current, open, close, expected, list };
