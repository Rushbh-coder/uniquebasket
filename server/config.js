'use strict';
/** Server-side configuration. Secrets live ONLY here (env / .env on the server PC) — never in the renderer. */
const path = require('path');
const cfg = {
  mode: process.env.APP_MODE || 'standalone',          // server | terminal | standalone (cloud = legacy alias of server)
  port: +process.env.PORT || 4310,
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  mongoUri: process.env.MONGO_URI || '',
  mongoDb: process.env.MONGO_DB || 'uniquebasket',
  memory: process.env.DB_MEMORY === '1',                 // tests only
  serverUrl: (process.env.SERVER_URL || '').replace(/\/$/, ''), // terminal mode: address of the shop server on the LAN
  terminalKey: process.env.TERMINAL_KEY || '',            // terminal mode: issued at enrolment, sent only by the local proxy
  terminalCode: process.env.TERMINAL_CODE || '',
  localTerminalCode: process.env.LOCAL_TERMINAL_CODE || 'MANAGER-PC', // the server PC's own counter
  adminPassword: process.env.ADMIN_PASSWORD || '',
  seedDemo: process.env.SEED_DEMO === '1',                // development seed data (never set in production)
  version: process.env.APP_VERSION || '3.0.0',
  backupDir: process.env.BACKUP_DIR || '',
  cloudSyncUrl: process.env.CLOUD_SYNC_URL || '',
  cloudSyncKey: process.env.CLOUD_SYNC_KEY || '',
};
if (cfg.mode === 'cloud') cfg.mode = 'server';
cfg.backupDir = cfg.backupDir || path.join(cfg.dataDir, 'backups');
module.exports = cfg;
