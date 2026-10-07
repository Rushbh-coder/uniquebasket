# Unique Basket – Multi-Counter Wholesale/Retail Billing (v3)

Electron + React desktop POS for one shop with **4 billing counters + 1 manager PC**, weighing scales, receipt printers,
inventory, customer credit, purchases, reports and a live manager dashboard. Works on low-spec Windows PCs (Celeron, 4 GB).

```
 MANAGER PC  (PC Setup: "Manager PC / Shop server")  ── MongoDB (local) ── daily backups
      │  LAN, port 4310 (HTTP + live events)
 ┌────┴──────────┬──────────────┬──────────────┐
 COUNTER-01   COUNTER-02     COUNTER-03     COUNTER-04   (PC Setup: "Counter PC")
 scale+printer scale+printer  scale+printer  scale+printer
```
* Counter PCs hold **no database password**. They enrol once with a code from Manager → Counters.
* Internet is **not** needed for billing (with MongoDB on the manager PC). Atlas still works if you prefer.
* Existing v2 data (users, products, bills, rate history) is upgraded in place on first start; bill numbering continues.

## Quick start (developer, Windows)
1. Install Node.js 20 LTS. `1-install.bat` (= `npm install`).
2. Copy `.env.example` to `.env`, set `ADMIN_PASSWORD` (and `MONGO_URI` if not local MongoDB).
3. `3-run-app.bat` (= `npm start`) → PC Setup → **Manager PC** → login `manager` / your password.
4. Tests: `6-run-tests.bat` (= `npm test`, 18 end-to-end API tests on an in-memory database).
5. Installer: `4-build-installer-exe.bat` → `dist/Wholesale Billing Setup 3.0.0.exe` (contains no secrets).

Demo data for trying things (never on a real shop): set `SEED_DEMO=1` → operator1-4 / operator123 (PIN 1111-1114), shopmgr / manager123 (PIN 9999), Tomato/Potato/Onion/Apple/Banana/Lemon.

## Documentation
| Topic | File |
|---|---|
| Audit of v2 + plan | docs/AUDIT_AND_PLAN.md |
| Shop setup: server PC, counters, LAN, MongoDB, backup/restore, installer | SETUP.md |
| Weighing scale & printer | docs/HARDWARE.md |
| Keyboard shortcuts | docs/SHORTCUTS.md |
| Roles & permissions | docs/PERMISSIONS.md |
| API | docs/API.md |
| Database & data rules | docs/DATABASE.md |
| Troubleshooting | docs/TROUBLESHOOTING.md |
| What is done / not done yet | docs/STATUS.md |

## Code map
```
main.js / preload.js / setup.html   Electron shell, secure print bridge, PC setup + enrolment
server/index.js                      local service: server | terminal (proxy) | standalone
server/config.js                     env config (secrets only here)
server/db/                           Mongo / NeDB / memory adapters, crash-safe transactions, migrations, seed
server/auth/                         login, sessions, PIN, approvals, RBAC matrix, terminal identity
server/services/                     invoices, products+prices, customers+ledger, purchases+stock, cash shifts,
                                     terminals, users, reports, backup, settings, audit
server/hardware/scale.js             scale adapters (serial/mock) + protocol parsers, signed readings
server/realtime.js                   live events (SSE) with one-time tickets
client/src/pos/Pos.jsx               keyboard-first billing screen
client/src/manager/*                 dashboard, bills, products, customers, purchases, stock, reports, admin
client/src/lib/shortcuts.js          the ONE shortcut registry
tests/api.test.js                    end-to-end API tests;  tests/e2e-ui.mjs  browser test (Playwright)
```
