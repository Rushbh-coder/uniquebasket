// Moves this PC from the cloud database (MongoDB Atlas) to the built-in database on this PC, so billing works
// without internet. The cloud data is only READ and copied; nothing in the cloud is changed or deleted.
//
//   node copy-cloud-data-to-this-pc.js              copy + switch this PC to the built-in database
//   node copy-cloud-data-to-this-pc.js --dry-run    only count the records in the cloud, change nothing
//
// Reads MONGO_URI / MONGO_DB from .env. Close the billing app first.
const fs = require('fs'), path = require('path'), net = require('net');
const { COLLECTIONS } = require('./server/db');
const dry = process.argv.includes('--dry-run');
const SKIP = new Set(['tx_journal', 'sessions']); // unfinished-transaction notes and logins belong to the old server
const env = {};
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) {}
const userData = process.env.APP_USER_DATA || path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), require('./package.json').name);
const dataDir = path.join(userData, 'data'), cfgPath = path.join(userData, 'config.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const portBusy = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
/** v2 could store ids as database objects; the built-in database needs plain text ids */
const plainId = (d) => (typeof d._id === 'string' ? d : { ...d, _id: String(d._id) });

(async () => {
  const uri = process.env.MONGO_URI || env.MONGO_URI, dbName = process.env.MONGO_DB || env.MONGO_DB || 'uniquebasket';
  if (!uri || /xxxxx|USER:PASSWORD/.test(uri)) throw new Error('No cloud database address found (MONGO_URI in .env).');
  if (!dry && await portBusy(+(process.env.PORT || env.PORT) || 4310)) throw new Error('The billing app is still open on this PC. Close it and run this again.');
  console.log(`Reading the cloud database "${dbName}" ...`);
  const cloud = await require('./server/db/mongo').open(uri, dbName);
  const data = {}; let total = 0;
  for (const c of COLLECTIONS) { if (SKIP.has(c)) continue; data[c] = (await cloud.collection(c).find({})).map(plainId); total += data[c].length; console.log(`  ${c.padEnd(16)} ${data[c].length}`); }
  await cloud.close();
  console.log(`Total ${total} records read.`);
  if (dry) { console.log('Dry run: nothing was changed on this PC.'); return; }

  // keep whatever is in the local data folder now (old v2 files) in a dated folder
  fs.mkdirSync(dataDir, { recursive: true });
  const old = fs.readdirSync(dataDir).filter((f) => f.endsWith('.db') || f.endsWith('.db~'));
  if (old.length) { const keep = path.join(dataDir, 'before-offline-' + stamp); fs.mkdirSync(keep); for (const f of old) fs.renameSync(path.join(dataDir, f), path.join(keep, f)); console.log(`Old local files kept in ${keep}`); }

  const local = await require('./server/db/nedb').open(dataDir);
  for (const c of Object.keys(data)) { const col = local.collection(c); for (const d of data[c]) await col.insert(d); }
  let bad = 0;
  for (const c of Object.keys(data)) { const n = await local.collection(c).count({}); if (n !== data[c].length) { bad++; console.log(`  MISMATCH ${c}: cloud ${data[c].length}, this PC ${n}`); } }
  await local.close();
  if (bad) throw new Error('The copy is not complete. This PC was NOT switched; it still uses the cloud database.');
  console.log(`Copied ${total} records to ${dataDir}`);

  let cur = {}; try { cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
  if (fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, path.join(userData, `config.before-offline-${stamp}.json`));
  fs.writeFileSync(cfgPath, JSON.stringify({ mode: 'server', db: 'local', counterId: cur.counterId || 'C1', savedAt: new Date().toISOString() }, null, 1));
  console.log('\nDONE. This PC now uses the built-in database and works without internet.');
  console.log('Start the app with 3-run-app.bat and log in with the same username and password as before.');
  console.log(`To go back to the cloud database: copy config.before-offline-${stamp}.json over config.json in ${userData}`);
})().catch((e) => { console.error('\nFAILED: ' + e.message); process.exitCode = 1; });
