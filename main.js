const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path'), fs = require('fs');
const cfgPath = path.join(app.getPath('userData'), 'config.json');   // this PC's role + counter name
process.env.DATA_DIR = path.join(app.getPath('userData'), 'data');   // only scale settings (and offline data in Single PC mode)
if (!app.requestSingleInstanceLock()) app.quit();

// Shop cloud settings: .env (when run from VS Code) or shop-config.json (bundled into the installer by `npm run dist`)
function shopConfig() {
  const o = {};
  try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#')) o[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) {}
  if (!o.MONGO_URI) try { Object.assign(o, JSON.parse(fs.readFileSync(path.join(__dirname, 'shop-config.json'), 'utf8'))); } catch (e) {}
  if (/xxxxx|USER:PASSWORD/.test(o.MONGO_URI || '')) delete o.MONGO_URI;
  return o;
}
ipcMain.handle('defaults', () => ({ hasMongo: !!shopConfig().MONGO_URI }));
ipcMain.handle('save', (e, c) => { fs.writeFileSync(cfgPath, JSON.stringify(c)); app.relaunch(); app.exit(0); });

app.whenReady().then(async () => {
  let cfg = null; try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
  const w = new BrowserWindow({ width: 1400, height: 860, autoHideMenuBar: true, title: 'Unique Basket Billing', webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  if (!cfg) return w.loadFile(path.join(__dirname, 'setup.html'));
  const shop = shopConfig();
  process.env.COUNTER_ID = cfg.counterId || 'C1';
  if (cfg.mode === 'cloud') {
    process.env.APP_MODE = 'server'; process.env.MONGO_URI = cfg.mongoUri || shop.MONGO_URI || '';
    process.env.MONGO_DB = shop.MONGO_DB || 'uniquebasket'; process.env.ADMIN_PASSWORD = cfg.adminPassword || shop.ADMIN_PASSWORD || '';
  } else { process.env.APP_MODE = cfg.mode; process.env.SERVER_URL = cfg.serverUrl || ''; }
  try {
    const { start } = require('./server/index');                       // loaded AFTER env is set
    const port = await start(4310, cfg.mode === 'server' ? '0.0.0.0' : '127.0.0.1');
    w.loadURL(`http://127.0.0.1:${port}`);
  } catch (e) {
    const r = dialog.showMessageBoxSync(w, { type: 'error', title: 'Cannot start', message: 'Could not connect to the cloud database.', detail: e.message + '\n\nCheck the internet connection and the MONGO_URI.', buttons: ['Quit', 'Change setup'] });
    if (r === 1) { try { fs.unlinkSync(cfgPath); } catch (x) {} app.relaunch(); }
    app.exit(0);
  }
});
app.on('window-all-closed', () => app.quit());
