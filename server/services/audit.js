'use strict';
/** Audit trail for every sensitive action. Never updated or deleted by the app. */
const { db } = require('../db');
const log = require('../lib/log');
/**
 * @param ctx {user, terminal} from the request
 * @param action e.g. "PRICE_CHANGE"
 * @param o {entity, entityId, old, new, reason, detail}
 * @param t optional transaction handle (so the audit row commits/rolls back with the change)
 */
async function audit(ctx, action, o = {}, t) {
  const u = (ctx && ctx.user) || {};
  const row = {
    at: new Date().toISOString(), user: u.username || o.user || 'system', role: u.role || '', terminal: (ctx && ctx.terminal && ctx.terminal.code) || '',
    ip: (ctx && ctx.ip) || '', action, entity: o.entity || '', entityId: o.entityId || '', old: o.old === undefined ? null : o.old,
    new: o.new === undefined ? null : o.new, reason: o.reason || '', detail: o.detail || '', approvedBy: o.approvedBy || '',
  };
  try { await (t ? t.audit : db.c.audit).insert(row); } catch (e) { log.error('audit write failed', e); if (t) throw e; }
  return row;
}
module.exports = { audit };
