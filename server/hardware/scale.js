'use strict';
/**
 * Weighing scale service — runs on the PC the scale is plugged into (inside that PC's local service).
 * Adapter architecture:
 *   transport: 'serial' (RS-232 / USB-serial via serialport) | 'mock' (simulator)
 *   protocol : a parser turning one line of scale output into {grams, stable, pcs}
 *     - 'generic'  : first number + optional unit, ST/US flags        e.g. "ST,GS,+024.650kg", " 24.650 kg"
 *     - 'stgs'     : strict "ST|US,GS|NT,+000.000kg" (many Indian/Chinese indicator heads)
 *     - 'plain-kg' : bare number in kg per line                      e.g. "18.450"
 *     - 'plain-g'  : bare number in grams per line                   e.g. "18450"
 *     - 'regex'    : custom pattern from settings; group 1 = weight, optional named groups unit / stable
 *   stability: protocol flag if present, otherwise N identical consecutive readings (configurable)
 * Every reading delivered to the screen is HMAC-signed so the server can tell a real scale weight from a typed one.
 * Do not assume your scale's format — use "Test scale" in Hardware settings and pick/adjust the protocol.
 */
const fs = require('fs'), path = require('path');
const reading = require('../lib/reading');
const log = require('../lib/log');

const PROTOCOLS = {
  generic(line) {
    const m = line.match(/([+-]?\s*\d+(?:\.\d+)?)\s*(kg|g|lb|pcs|pc)?/i); if (!m) return null;
    const n = parseFloat(m[1].replace(/\s/g, '')); const u = (m[2] || 'kg').toLowerCase();
    const flag = /\bUS\b|\bMO\b/i.test(line) ? false : /\bST\b/i.test(line) ? true : null;
    if (u.startsWith('pc')) return { pcs: Math.round(n), stable: flag };
    return { grams: Math.round(u === 'g' ? n : u === 'lb' ? n * 453.59237 : n * 1000), stable: flag };
  },
  stgs(line) {
    const m = line.match(/^(ST|US|OL)\s*,\s*(GS|NT|TR)\s*,\s*([+-]?\s*\d+(?:\.\d+)?)\s*(kg|g)/i); if (!m) return null;
    if (m[1].toUpperCase() === 'OL') return { error: 'Overload' };
    const n = parseFloat(m[3].replace(/\s/g, ''));
    return { grams: Math.round(m[4].toLowerCase() === 'g' ? n : n * 1000), stable: m[1].toUpperCase() === 'ST' };
  },
  'plain-kg'(line) { const m = line.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*$/); return m ? { grams: Math.round(parseFloat(m[1]) * 1000), stable: null } : null; },
  'plain-g'(line) { const m = line.match(/^\s*([+-]?\d+)\s*$/); return m ? { grams: parseInt(m[1], 10), stable: null } : null; },
  regex(line, cfg) {
    let rx; try { rx = new RegExp(cfg.pattern || '([+-]?\\d+(?:\\.\\d+)?)', 'i'); } catch (e) { return { error: 'Bad pattern' }; }
    const m = line.match(rx); if (!m) return null;
    const n = parseFloat(m[1]); const u = ((m.groups && m.groups.unit) || cfg.unit || 'kg').toLowerCase();
    const st = m.groups && m.groups.stable != null ? /^(st|s|1|stable)$/i.test(m.groups.stable) : null;
    return { grams: Math.round(u === 'g' ? n : n * 1000), stable: st };
  },
};
const DEFAULT = { transport: 'mock', path: '', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', protocol: 'generic', pattern: '', unit: 'kg', lineEnd: 'LF', stableCount: 3, emptyBelow: 20, requestCmd: '' };
class Scale {
  constructor({ dataDir, terminal, secret }) {
    this.file = path.join(dataDir, 'scale.json'); this.terminal = terminal; this.secret = secret;
    this.cfg = { ...DEFAULT }; this.port = null; this.retry = null; this.hist = []; this.listeners = new Set(); this.lastLines = [];
    this.state = { connected: false, grams: 0, pcs: null, stable: false, error: '', mode: 'mock', at: null };
    try { const old = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.cfg = { ...DEFAULT, ...old, transport: old.transport || old.mode || 'mock' }; } catch (e) {}
  }
  setIdentity(terminal, secret) { this.terminal = terminal; this.secret = secret; }
  snapshot() {
    const at = new Date().toISOString();
    const base = { ...this.state, transport: this.cfg.transport, protocol: this.cfg.protocol, at };
    if (!this.secret || !this.state.connected) return base;
    const r = reading.sign(this.secret, { grams: this.state.grams, at, terminal: this.terminal, mock: this.cfg.transport === 'mock' });
    return { ...base, reading: r };
  }
  push() { const s = this.snapshot(); for (const fn of this.listeners) { try { fn(s); } catch (e) {} } }
  onLine(line) {
    this.lastLines = [...this.lastLines, line].slice(-10);
    const fn = PROTOCOLS[this.cfg.protocol] || PROTOCOLS.generic;
    const r = fn(line, this.cfg);
    if (!r) return;
    if (r.error) { this.state.error = r.error; return this.push(); }
    if (r.pcs != null) { this.state.pcs = r.pcs; return this.push(); }
    if (r.grams < 0) { this.state.error = 'Negative weight — tare/zero the scale'; this.state.grams = 0; this.state.stable = false; return this.push(); }
    this.state.error = ''; this.state.grams = r.grams;
    this.hist = [...this.hist, r.grams].slice(-Math.max(2, this.cfg.stableCount));
    this.state.stable = r.stable != null ? r.stable : this.hist.length >= this.cfg.stableCount && this.hist.every((x) => x === this.hist[0]);
    this.push();
  }
  later() { clearTimeout(this.retry); if (this.cfg.transport === 'serial') this.retry = setTimeout(() => this.apply(), 5000); }
  fail(e) { this.state.connected = false; this.state.error = /denied|busy|EBUSY|in use|Access/i.test(e.message) ? 'Port already in use (close other scale software)' : /not found|cannot open|No such file|File not found/i.test(e.message) ? `Port ${this.cfg.path} not found` : e.message; this.push(); this.later(); }
  async apply() {
    clearTimeout(this.retry); clearInterval(this.poll);
    const old = this.port; this.port = null;
    if (old) { try { old.isOpen && old.close(); } catch (e) {} }
    this.hist = [];
    if (this.cfg.transport !== 'serial') { Object.assign(this.state, { mode: 'mock', connected: true, error: '', grams: 0, pcs: null, stable: true }); return this.push(); }
    Object.assign(this.state, { mode: 'serial', connected: false, grams: 0, pcs: null, error: '', stable: false });
    if (!this.cfg.path) { this.state.error = 'Set the COM port'; return this.push(); }
    try {
      const { SerialPort, ReadlineParser } = require('serialport');
      const p = (this.port = new SerialPort({ path: this.cfg.path, baudRate: +this.cfg.baudRate, dataBits: +this.cfg.dataBits, stopBits: +this.cfg.stopBits, parity: this.cfg.parity, autoOpen: false }));
      p.pipe(new ReadlineParser({ delimiter: this.cfg.lineEnd === 'CR' ? '\r' : '\n' })).on('data', (l) => this.onLine(String(l).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim()));
      p.on('error', (e) => this.fail(e));
      p.on('close', () => { if (this.port !== p) return; this.state.connected = false; this.state.error = 'Scale disconnected'; this.push(); this.later(); });
      p.open((err) => {
        if (err) return this.fail(err);
        this.state.connected = true; this.state.error = ''; this.push();
        if (this.cfg.requestCmd) this.poll = setInterval(() => { try { p.write(this.cfg.requestCmd.replace(/\\r/g, '\r').replace(/\\n/g, '\n')); } catch (e) {} }, 300);
      });
    } catch (e) { this.fail(e); }
  }
  async configure(c) {
    const n = { ...this.cfg };
    if (c.transport != null) n.transport = c.transport === 'serial' ? 'serial' : 'mock';
    if (c.path != null) n.path = String(c.path).slice(0, 60);
    for (const k of ['baudRate', 'dataBits', 'stopBits', 'stableCount', 'emptyBelow']) if (c[k] != null) { const x = parseInt(c[k], 10); if (!Number.isFinite(x) || x <= 0 || x > 1e6) throw new Error(`Invalid ${k}`); n[k] = x; }
    if (c.parity != null) { if (!['none', 'even', 'odd', 'mark', 'space'].includes(c.parity)) throw new Error('Invalid parity'); n.parity = c.parity; }
    if (c.protocol != null) { if (!PROTOCOLS[c.protocol]) throw new Error('Unknown protocol'); n.protocol = c.protocol; }
    if (c.pattern != null) { try { new RegExp(c.pattern); } catch (e) { throw new Error('Pattern is not a valid regular expression'); } n.pattern = String(c.pattern).slice(0, 200); }
    if (c.lineEnd != null) n.lineEnd = c.lineEnd === 'CR' ? 'CR' : 'LF';
    if (c.unit != null) n.unit = c.unit === 'g' ? 'g' : 'kg';
    if (c.requestCmd != null) n.requestCmd = String(c.requestCmd).slice(0, 20);
    this.cfg = n;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 1));
    await this.apply();
  }
  disconnect() { const p = this.port; this.port = null; clearTimeout(this.retry); clearInterval(this.poll); if (p) try { p.close(); } catch (e) {} Object.assign(this.state, { connected: false, error: 'Disconnected by user' }); this.push(); }
  simulate({ grams, stable = true, pcs = null }) {
    if (this.cfg.transport !== 'mock') throw new Error('Simulator only works in mock mode');
    Object.assign(this.state, { grams: Math.max(0, Math.round(+grams || 0)), stable: stable !== false, pcs: pcs == null || pcs === '' ? null : Math.round(+pcs), error: '' });
    this.push();
  }
  /** test: parse sample text without a scale (for picking the right protocol) */
  static testParse(protocol, sample, cfg = {}) { const fn = PROTOCOLS[protocol]; if (!fn) throw new Error('Unknown protocol'); return String(sample).split(/\r\n|\n|\r/).filter(Boolean).map((l) => ({ line: l, result: fn(l, cfg) })); }
  static async ports() { try { const { SerialPort } = require('serialport'); return (await SerialPort.list()).map((p) => ({ path: p.path, name: [p.manufacturer, p.friendlyName].filter(Boolean).join(' ') })); } catch (e) { log.warn('serial list failed ' + e.message); return []; } }
  subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); }
}
module.exports = { Scale, PROTOCOLS: Object.keys(PROTOCOLS), DEFAULT };
