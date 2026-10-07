'use strict';
/** Routes served by EVERY PC's own local service for hardware attached to that PC (scale).
 *  On counter PCs these are answered locally; everything else is forwarded to the shop server. */
const express = require('express');
const { Scale } = require('../hardware/scale');
const { can, P } = require('../auth/rbac');
const { Unauthorized, Forbidden, BadRequest } = require('../lib/errors');
const { token } = require('../lib/ids');

module.exports = function localRoutes({ scale, identify }) {
  const r = express.Router();
  const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((x) => { if (!res.headersSent) res.json(x === undefined ? { ok: true } : x); }).catch(next);
  /** identify(req) -> user {username, role} or throws */
  const need = (perm) => async (req, res, next) => { try { req.user = await identify(req); if (perm && !can(req.user.role, perm)) throw new Forbidden(); next(); } catch (e) { next(e); } };
  const tickets = new Map();
  r.get('/scale/state', need(), (req, res) => res.json(scale.snapshot()));
  r.post('/scale/ticket', need(), (req, res) => { const t = token(16); tickets.set(t, Date.now() + 60000); res.json({ ticket: t }); });
  r.get('/scale/stream', (req, res) => {
    const exp = tickets.get(String(req.query.ticket || '')); tickets.delete(String(req.query.ticket || ''));
    if (!exp || exp < Date.now()) return res.status(401).json({ error: 'Please login' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const off = scale.subscribe((s) => { try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch (e) {} });
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { off(); clearInterval(ping); });
  });
  r.get('/scale/config', need(P.TERMINAL_MANAGE), h(async () => ({ cfg: scale.cfg, status: scale.snapshot(), protocols: require('../hardware/scale').PROTOCOLS, lastLines: scale.lastLines })));
  r.get('/scale/ports', need(P.TERMINAL_MANAGE), h(() => Scale.ports()));
  r.post('/scale/config', need(P.TERMINAL_MANAGE), h(async (req) => { try { await scale.configure(req.body || {}); } catch (e) { throw new BadRequest(e.message); } return { ok: true, status: scale.snapshot() }; }));
  r.post('/scale/connect', need(P.TERMINAL_MANAGE), h(async () => { await scale.apply(); return scale.snapshot(); }));
  r.post('/scale/disconnect', need(P.TERMINAL_MANAGE), h(async () => { scale.disconnect(); return scale.snapshot(); }));
  r.post('/scale/test-parse', need(P.TERMINAL_MANAGE), h(async (req) => { try { return Scale.testParse(req.body.protocol, String(req.body.sample || '').slice(0, 2000), req.body); } catch (e) { throw new BadRequest(e.message); } }));
  r.post('/scale/simulate', need(), h(async (req) => {
    if (scale.cfg.transport !== 'mock') throw new BadRequest('Simulator only works in mock mode');
    scale.simulate(req.body || {}); return scale.snapshot();
  }));
  return r;
};
