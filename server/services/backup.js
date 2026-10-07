'use strict';
/**
 * Backups: JSON export of every collection into a dated folder (works for MongoDB and NeDB alike, no extra tools).
 * Automatic daily backup on the server PC + "Backup now". Restore is a controlled, audited replace of all data.
 * For MongoDB you may additionally use `mongodump` (documented); this built-in backup needs nothing installed.
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { db, COLLECTIONS, mutex } = require('../db');
const cfg = require('../config');
const log = require('../lib/log');
const { audit } = require('./audit');
const { BadRequest, NotFound } = require('../lib/errors');
const SKIP = new Set(['tx_journal', 'sessions']);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
async function backupNow(by = 'auto') {
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  const name = `backup-${stamp()}.json.gz`, file = path.join(cfg.backupDir, name);
  const t0 = Date.now();
  // take the snapshot inside the write lock so it is consistent (no half-saved bill)
  const data = await mutex.run(async () => { const o = { meta: { at: new Date().toISOString(), version: cfg.version, kind: db.kind } }; for (const c of COLLECTIONS) if (!SKIP.has(c)) o[c] = await db.c[c].find({}); return o; });
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  fs.writeFileSync(file + '.part', buf); fs.renameSync(file + '.part', file);
  const rec = await db.c.backups.insert({ at: new Date().toISOString(), file: name, size: buf.length, status: 'OK', by, ms: Date.now() - t0, location: 'local' });
  await prune();
  log.info(`backup ${name} ${buf.length} bytes`);
  return rec;
}
async function prune() {
  const keep = ((await require('./settings').get()).backup.keepDays || 30);
  const cutoff = Date.now() - keep * 864e5;
  for (const f of fs.readdirSync(cfg.backupDir)) if (/^backup-.*\.json\.gz$/.test(f) && fs.statSync(path.join(cfg.backupDir, f)).mtimeMs < cutoff) fs.rmSync(path.join(cfg.backupDir, f), { force: true });
}
async function list() { return db.c.backups.find({}, { sort: { at: -1 }, limit: 100 }); }
async function restore(req, fileName) {
  if (!/^backup-[\dT-]+\.json\.gz$/.test(fileName || '')) throw new BadRequest('Choose a backup file');
  const file = path.join(cfg.backupDir, fileName);
  if (!fs.existsSync(file)) throw new NotFound('Backup file not found');
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  await backupNow('before-restore:' + req.user.username);         // safety copy of current data first
  await mutex.run(async () => {
    for (const c of COLLECTIONS) {
      if (SKIP.has(c) || c === 'backups' || !Array.isArray(data[c])) continue;
      await db.c[c].remove({}, { multi: true });
      for (const d of data[c]) await db.c[c].insert(d);
    }
  });
  require('./settings').reset();
  await audit(req, 'BACKUP_RESTORED', { detail: fileName });
  return { ok: true, restoredFrom: data.meta };
}
let timer;
function schedule() {
  const tick = async () => {
    try {
      const s = (await require('./settings').get()).backup;
      const [h, m] = (s.dailyAt || '23:30').split(':').map(Number);
      const now = new Date(); const today = require('../lib/dates').businessDate(now);
      const last = (await db.c.backups.find({ by: 'auto' }, { sort: { at: -1 }, limit: 1 }))[0];
      const lastDay = last ? require('../lib/dates').businessDate(new Date(last.at)) : '';
      const hm = new Intl.DateTimeFormat('en-GB', { timeZone: require('../lib/dates').TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).split(':').map(Number);
      if (lastDay !== today && (hm[0] > h || (hm[0] === h && hm[1] >= m))) await backupNow('auto');
    } catch (e) { log.error('auto backup failed', e); try { await db.c.backups.insert({ at: new Date().toISOString(), status: 'FAILED', error: e.message, by: 'auto' }); } catch (x) {} }
  };
  timer = setInterval(tick, 10 * 60000); timer.unref && timer.unref();
}
module.exports = { backupNow, list, restore, schedule, stop: () => clearInterval(timer) };
