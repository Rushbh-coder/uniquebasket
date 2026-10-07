/**
 * Electron main process.
 *  - starts this PC's local service (server/index.js) in the mode chosen in PC Setup
 *  - renderer is sandboxed: contextIsolation ON, nodeIntegration OFF; only `window.pos` (print) and `window.setup` are exposed
 *  - secrets (DB address on the server PC, terminal key on counters) are encrypted with Windows DPAPI (safeStorage)
 *  - default menu removed so the browser accelerators (Ctrl+R reload, F11 fullscreen...) never steal billing shortcuts
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const cfgPath = path.join(app.getPath('userData'), 'config.json');
process.env.DATA_DIR = path.join(app.getPath('userData'), 'data');
process.env.APP_VERSION = app.getVersion();
if (!app.requestSingleInstanceLock()) app.quit();
Menu.setApplicationMenu(null);

const enc = (s) => (s && safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(String(s)).toString('base64') : s || '');
const dec = (s) => (typeof s === 'string' && s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s || '');
/** developer runs from VS Code may keep MONGO_URI etc in .env (server PC only — never bundled into installers) */
function devEnv() {
  const o = {};
  try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#')) o[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) {}
  if (/xxxxx|USER:PASSWORD/.test(o.MONGO_URI || '')) delete o.MONGO_URI;
  return o;
}
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { return null; } };
const writeCfg = (c) => { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); fs.writeFileSync(cfgPath, JSON.stringify(c, null, 1)); };

ipcMain.handle('setup:defaults', () => ({ hasMongo: !!devEnv().MONGO_URI, host: os.hostname(), ips: Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address) }));
ipcMain.handle('setup:save', async (e, c) => {
  const mode = ['server', 'terminal', 'standalone'].includes(c && c.mode) ? c.mode : null;
  if (!mode) throw new Error('Choose how this PC works');
  const out = { mode, savedAt: new Date().toISOString() };
  if (mode === 'server' && c.db === 'local') out.db = 'local'; // built-in file database on this PC: no internet, nothing to install
  else if (mode === 'server') {
    const uri = String(c.mongoUri || devEnv().MONGO_URI || 'mongodb://127.0.0.1:27017/?directConnection=true');
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error('Database address must start with mongodb:// or mongodb+srv://');
    out.mongoUri = enc(uri); out.mongoDb = String(c.mongoDb || devEnv().MONGO_DB || 'uniquebasket').replace(/[^A-Za-z0-9_-]/g, '');
  }
  if (mode === 'server' || mode === 'standalone') {
    if (c.adminPassword && String(c.adminPassword).length < 8) throw new Error('Manager password must be at least 8 characters');
    if (c.adminPassword) out.firstAdminPassword = enc(c.adminPassword); // used once, removed after first start
    out.counterId = String(c.counterId || 'C1').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'C1';
  }
  if (mode === 'terminal') {
    const url = String(c.serverUrl || '').trim().replace(/\/$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error('Server address looks wrong, e.g. http://192.168.1.10:4310');
    let r;
    try { r = await fetch(url + '/api/terminals/enrol', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enrolCode: String(c.enrolCode || '').trim(), machine: os.hostname() }), signal: AbortSignal.timeout(8000) }); }
    catch (x) { throw new Error('Cannot reach the shop server at ' + url + '. Is the manager PC on and on the same network?'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Enrolment failed');
    Object.assign(out, { serverUrl: url, terminalKey: enc(j.terminalKey), scaleSecret: enc(j.scaleSecret), terminalCode: j.code, terminalName: j.name });
  }
  writeCfg(out); app.relaunch(); app.exit(0);
});
/* ---------- printing: silent, to the counter's configured printer; optional PDF copy saved on this PC ---------- */
const billPdf = require('./bill-pdf');
const SAVE_MODES = ['OFF', 'PRINT_AND_SAVE', 'SAVE_ONLY'];
ipcMain.handle('pos:openBills', async () => { const dir = billPdf.billsDir(app.getPath('documents')); fs.mkdirSync(dir, { recursive: true }); const err = await shell.openPath(dir); return { ok: !err, error: err, dir }; });
ipcMain.handle('pos:printers', async (e) => (await e.sender.getPrintersAsync()).map((p) => ({ name: p.name, isDefault: p.isDefault, status: p.status })));
ipcMain.handle('pos:print', async (e, o) => {
  const html = typeof (o && o.html) === 'string' && o.html.length < 2e6 ? o.html : null;
  if (!html) return { ok: false, error: 'nothing to print' };
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const save = SAVE_MODES.includes(o.save) ? o.save : 'OFF';
    let saved = '', saveError = '';
    if (save !== 'OFF') { try { saved = await billPdf.savePdf(w.webContents, { documents: app.getPath('documents'), fileName: o.fileName, paper: o.paper, heightMm: o.heightMm }); } catch (x) { saveError = x.message; } }
    if (save === 'SAVE_ONLY') return { ok: !!saved, error: saved ? '' : 'Could not save the bill file: ' + saveError, saved, saveError };
    const width = o.paper === '58mm' ? 58000 : o.paper === 'A4' ? 210000 : 80000;
    // A4 invoice has white text on green bars, so its backgrounds must print; thermal paper stays plain black
    const opts = { silent: o.silent !== false, printBackground: o.paper === 'A4', deviceName: String(o.deviceName || ''), copies: Math.min(Math.max(+o.copies || 1, 1), 5), margins: { marginType: 'none' } };
    if (o.paper !== 'A4') opts.pageSize = { width, height: 297000 };
    return await new Promise((res) => w.webContents.print(opts, (ok, err) => res({ ok, error: ok ? '' : err || 'Printer not available', saved, saveError })));
  } catch (x) { return { ok: false, error: x.message }; } finally { setTimeout(() => !w.isDestroyed() && w.destroy(), 1500); }
});

app.whenReady().then(async () => {
  const cfg = readCfg();
  const w = new BrowserWindow({ width: 1366, height: 768, minWidth: 1024, minHeight: 640, title: 'Unique Basket Billing', backgroundColor: '#e9edf1', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  w.once('ready-to-show', () => { w.maximize(); w.show(); });
  w.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://wa.me/')) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('file://')) e.preventDefault(); });
  w.webContents.on('before-input-event', (e, i) => { if (i.control && i.shift && i.key.toLowerCase() === 'i' && !process.env.DEVTOOLS) e.preventDefault(); });
  if (!cfg || !['server', 'terminal', 'standalone', 'cloud'].includes(cfg.mode)) return w.loadFile(path.join(__dirname, 'setup.html'));
  const env = devEnv();
  // legacy v2 "cloud" PCs (each PC talking to Atlas directly) keep working as a server until re-setup
  const mode = cfg.mode === 'cloud' ? 'server' : cfg.mode;
  process.env.APP_MODE = mode;
  if (mode === 'server' && cfg.db === 'local') process.env.MONGO_URI = ''; // empty = built-in file database (ignores .env)
  else if (mode === 'server') { process.env.MONGO_URI = dec(cfg.mongoUri) || cfg.mongoUri_plain || env.MONGO_URI || ''; process.env.MONGO_DB = cfg.mongoDb || env.MONGO_DB || 'uniquebasket'; }
  if (mode === 'server' || mode === 'standalone') { process.env.COUNTER_ID = cfg.counterId || 'C1'; process.env.ADMIN_PASSWORD = dec(cfg.firstAdminPassword) || cfg.adminPassword || env.ADMIN_PASSWORD || ''; }
  if (mode === 'terminal') Object.assign(process.env, { SERVER_URL: cfg.serverUrl, TERMINAL_KEY: dec(cfg.terminalKey), SCALE_SECRET: dec(cfg.scaleSecret), TERMINAL_CODE: cfg.terminalCode });
  if (cfg.mode === 'cloud' && cfg.mongoUri && !String(cfg.mongoUri).startsWith('enc:')) { cfg.mongoUri = enc(cfg.mongoUri); cfg.mode = 'server'; writeCfg(cfg); } // migrate plain-text legacy secret
  try {
    const { start } = require('./server/index');
    const port = await start(4310, mode === 'server' ? '0.0.0.0' : '127.0.0.1');
    if (cfg.firstAdminPassword || cfg.adminPassword) { delete cfg.firstAdminPassword; delete cfg.adminPassword; writeCfg(cfg); }
    w.loadURL(`http://127.0.0.1:${port}`);
  } catch (e) {
    const r = dialog.showMessageBoxSync(w, { type: 'error', title: 'Cannot start', message: mode === 'server' ? 'Could not open the shop database.' : 'Could not start the billing service.', detail: e.message + (mode === 'server' && cfg.db !== 'local' ? '\n\nIs MongoDB running on this PC (or internet available for Atlas)?' : ''), buttons: ['Quit', 'Retry', 'Change PC setup'] });
    if (r === 1) app.relaunch();
    if (r === 2) { try { fs.renameSync(cfgPath, cfgPath + '.old'); } catch (x) {} app.relaunch(); }
    app.exit(0);
  }
});
app.on('window-all-closed', () => app.quit());
