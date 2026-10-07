// UI end-to-end: server (manager PC) + counter PC in terminal mode, real Chromium, keyboard only.
// Requires: npm i -D playwright  (then: node tests/e2e-ui.mjs)
import { chromium } from 'playwright';
import { spawn } from 'child_process'; import fs from 'fs';
const OUT = process.env.SHOTS || '/tmp/claude-0/shots'; fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, NODE_PATH: 'tests/shims/node_modules', DB_MEMORY: '1', SEED_DEMO: '1', NODE_ENV: 'test' };
const run = (e) => { const p = spawn('node', ['server/index.js'], { env: { ...env, ...e }, stdio: ['ignore', 'pipe', 'pipe'] }); p.stderr.on('data', (d) => process.stderr.write('[' + e.APP_MODE + '] ' + d)); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (url, o = {}) => { const r = await fetch(url, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) }); return r.json(); };
const S = 'http://127.0.0.1:4501', C = 'http://127.0.0.1:4502';
const server = run({ APP_MODE: 'server', PORT: '4501', DATA_DIR: '/tmp/claude-0/e2e-s' });
await wait(1500);
const m = await j(S + '/api/login', { method: 'POST', body: { username: 'manager', password: 'manager123' } }); const H = { Authorization: 'Bearer ' + m.token };
await j(S + '/api/settings', { method: 'PUT', headers: H, body: { billing: { allowMockScale: true } } });
const t = await j(S + '/api/terminals', { method: 'POST', headers: H, body: { code: 'COUNTER-01', name: 'Main Counter 1', series: 'C2' } });
const en = await j(S + '/api/terminals/enrol', { method: 'POST', body: { enrolCode: t.enrolCode, machine: 'PC-01' } });
const counter = run({ APP_MODE: 'terminal', PORT: '4502', DATA_DIR: '/tmp/claude-0/e2e-c', SERVER_URL: S, TERMINAL_KEY: en.terminalKey, SCALE_SECRET: en.scaleSecret, TERMINAL_CODE: en.code });
await wait(1200);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
let printed = 0; await ctx.exposeFunction('__printed', () => printed++);
await ctx.addInitScript(() => { window.pos = { print: async (o) => { window.__printed(); return { ok: true }; }, printers: async () => [{ name: 'POS-80', isDefault: true }] }; });
const op = await ctx.newPage();
const errs = []; op.on('pageerror', (e) => errs.push(e.message)); op.on('console', (x) => x.type() === 'error' && errs.push(x.text()));
await op.goto(C); await op.waitForSelector('text=COUNTER-01');
await op.keyboard.type('operator1'); await op.keyboard.press('Tab'); await op.keyboard.type('1111'); await op.keyboard.press('Enter');
await op.waitForSelector('text=GRAND TOTAL');
const otok = (await j(C + '/api/login', { method: 'POST', body: { username: 'operator2', password: '1112' } })).token;
const sim = (g) => j(C + '/api/scale/simulate', { method: 'POST', headers: { Authorization: 'Bearer ' + otok }, body: { grams: g, stable: true } });
// item 1: Tomato on scale
await op.keyboard.type('tom'); await op.keyboard.press('Enter'); await sim(18450); await wait(400);
await op.screenshot({ path: OUT + '/1-weighing.png' });
await op.keyboard.press('Enter'); await wait(200); await sim(0);
// item 2: Lemon x5 (count)
await op.keyboard.type('LEM'); await op.keyboard.press('Enter'); await op.keyboard.type('5'); await op.keyboard.press('Enter');
// item 3: manual weight potato 2.5 kg (will need manager PIN on save)
await op.keyboard.type('potato'); await op.keyboard.press('Enter'); await op.keyboard.type('2.500'); await op.keyboard.press('Enter');
await wait(200);
// manager changes Tomato price while bill is open
const ps = await j(S + '/api/products', { headers: H }); const tom = ps.find((p) => p.code === 'TOM');
await j(S + `/api/products/${tom._id}/price`, { method: 'POST', headers: H, body: { rate: 3400 } });
await op.waitForSelector('text=Tomato rate updated to ₹34.00 for new entries.', { timeout: 5000 });
await op.screenshot({ path: OUT + '/2-bill-open-price-changed.png' });
const gt = await op.textContent('.grand b'); console.log('grand total on screen', gt);
// pay: F8, mixed? simple cash with received 1000
await op.keyboard.press('F8'); await op.waitForSelector('text=Cash received'); await op.keyboard.type('1000');
await op.screenshot({ path: OUT + '/3-payment.png' });
await op.keyboard.press('Enter');
await op.waitForSelector('text=Manager approval'); await op.keyboard.type('shopmgr'); await op.keyboard.press('Tab'); await op.keyboard.type('9999'); await op.keyboard.press('Enter');
await op.waitForSelector('text=/Saved INV\\/.*C2-000001/', { timeout: 8000 });
await op.screenshot({ path: OUT + '/4-saved.png' });
const bills = await j(S + '/api/bills', { headers: H }); const b = bills[0];
console.log('bill', b.no, 'items', b.items.map((l) => `${l.name} ${l.qty} @${l.rate} ${l.src}/${l.rateSrc}`).join(' | '), 'total', b.total, 'change', b.change, 'terminal', b.terminalCode);
// new tomato line after the price change gets ₹34
await op.keyboard.type('tom'); await op.keyboard.press('Enter'); await sim(1000); await wait(300); await op.keyboard.press('Enter'); await wait(200); await sim(0);
console.log('new line rate', await op.textContent('.grid tbody tr td:nth-child(6)'));
await op.keyboard.press('F11'); await op.waitForSelector('text=Bill held'); // hold
// manager view
const mp = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage(); mp.on('pageerror', (e) => errs.push('mgr: ' + e.message));
await mp.goto(S); await mp.fill('input[autocomplete=username]', 'manager'); await mp.fill('input[type=password]', 'manager123'); await mp.keyboard.press('Enter');
await mp.waitForSelector('text=Live bill monitor'); await wait(500);
await mp.screenshot({ path: OUT + '/5-dashboard.png' });
for (const tab of ['Products & Rates', 'Bills', 'Reports', 'Counters', 'Hardware', 'Settings', 'Audit log', 'Customers', 'Stock', 'Purchases', 'Users', 'Backup']) { await mp.click(`nav >> text=${tab}`); await wait(350); if (['Products & Rates', 'Counters', 'Audit log', 'Hardware'].includes(tab)) await mp.screenshot({ path: `${OUT}/6-${tab.replace(/\W+/g, '_')}.png` }); }
// live: operator bills again from held -> dashboard updates
await mp.click('nav >> text=Dashboard');
await op.keyboard.press('F11'); await op.waitForSelector('text=Held bills'); await op.keyboard.press('Enter'); await wait(300); await op.keyboard.press('F6');
await mp.waitForSelector('text=C2-000002', { timeout: 6000 }); console.log('manager saw bill C2-000002 live');
await mp.screenshot({ path: OUT + '/7-dashboard-live.png' });
console.log('receipts printed (silent bridge):', printed);
console.log('page errors:', errs.length ? errs : 'none');
await browser.close(); counter.kill(); server.kill();
