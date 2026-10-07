# Unique Basket Billing — Audit & Implementation Plan

Audited: `wholesale-billing-desktop` v2.0.0 (git: 2 commits, plus uncommitted edits to `App.jsx`, `main.js`, `server/index.js`, `styles.css`).
Date: 06-Oct-2026

---

## ⚠ URGENT security finding (do this today, before anything else)

`shop-config.json` contains a **live MongoDB Atlas connection string with username and password**.
`npm run dist` copies it into the installer, so **`dist/Wholesale Billing Setup 2.0.0.exe` contains the password in plain text** (Electron `app.asar` is just an archive, not encryption). Anyone with a copy of the installer can read, change or delete all your shop data.

1. In MongoDB Atlas → Database Access → change the password for that DB user (or delete the user and create a new one).
2. Atlas → Network Access → remove `0.0.0.0/0` if possible.
3. Do not share the existing `.exe` again. Delete copies from USB drives/Dropbox.
4. The new architecture (below) never puts database credentials on counter PCs.

---

## A. Current project audit

### Stack
| Layer | What exists |
|---|---|
| Desktop shell | Electron 31 (`main.js`), single window, single-instance lock |
| Preload | `preload.js` — exposes only `setup.save` / `setup.defaults` (setup screen). Safe. |
| Renderer | React 18 + Vite 5, **plain JSX, one 272-line file** `client/src/App.jsx`, no router (tab state), no state library |
| Styling | Hand-written `styles.css` (68 lines, CSS variables, dark mode). No Tailwind. |
| Backend | Express 4 in **one 735-line file** `server/index.js`, runs *inside* Electron main process on port 4310 |
| Database | Two interchangeable backends behind one wrapper: **NeDB** (local files, "Single PC" mode) or **MongoDB Atlas** (cloud, "Cloud PC" mode — every PC connects straight to Atlas) |
| Auth | bcrypt hashes, JWT (12 h) with secret stored in DB `settings`, in-memory login lockout (5 attempts / 1 min) |
| Real-time | Only Server-Sent Events for the **scale** stream. No sockets. Manager screens need manual reload. |
| Scale | `serialport` 12, generic regex line parser, mock simulator, stability = `ST/US` flag or 3 equal readings, auto-reconnect every 5 s, config saved per PC in `scale.json` |
| Printing | `window.print()` → Windows print dialog, 80 mm CSS only |
| Extras | WhatsApp share via `wa.me` link (opens on every save), Dockerfile + `cloud.js` for hosted mode, `.bat` helper scripts |

### PC modes (setup.html)
1. **Cloud PC** (recommended in SETUP.md) — every PC runs its own Express and connects directly to Atlas. **No internet = no billing.**
2. **Single PC** — NeDB on that PC only; data not shared.
3. **Counter → hosted server** — local Express proxies `/api/*` (except scale) to a remote server.

### Data model (Mongo/NeDB collections)
`users`, `products` (`name, unit KG|PCS, rate paise, unitWeight g, stock g|pcs, code, active`), `bills` (embedded items with rate snapshot), `rates` (price history), `settings` (JWT secret + per-counter sequence), `audit`.

### Good things worth keeping
- **Money in integer paise, weight in integer grams.** No floating-point money. Kept as-is.
- **Server recalculates every bill**; client totals are not trusted.
- **Invoice lines already snapshot** name, unit, rate, amount → old bills don't change when rates change.
- **Price history** (`rates`) already written on every rate change.
- **Per-counter invoice series** `INV/2026-27/C1-000001` via atomic increment. Indian FY logic present.
- Operator can't change rate or enter manual weight (server-enforced), manual weight audited.
- Cancel = status change with reason + stock reversal (no delete).
- Scale reconnect loop, port-busy detection, mock simulator — good base for an adapter architecture.
- Electron defaults are safe: `contextIsolation` on, `nodeIntegration` off, external links denied except WhatsApp.

### Existing keyboard shortcuts (preserved exactly)
Active only when focus is **not** in an input/select:
| Key | Action |
|---|---|
| F4 / C | Capture weight from scale |
| F5 / A | Add item |
| F6 / S | Save bill (+ print + WhatsApp) |
| M | Manual weight (manager) |
| N | Next product |
| P | Focus product dropdown |

### Bugs and problems found
| # | Severity | Problem |
|---|---|---|
| 1 | **Critical** | DB password in `shop-config.json` and inside the installer (see top). |
| 2 | **Critical** | **Operator can bypass the scale**: the bill-items table has editable qty inputs; the edited line keeps `src: 'SCALE'`, so the server accepts any typed weight as a scale reading. |
| 3 | **Critical** | **No discount limit**: operator can discount up to 100% of the bill. |
| 4 | High | `prompt()` is **not supported in Electron** — "Manual Weight" and "Cancel bill → reason" do nothing in the desktop app (they only work in the browser). |
| 5 | High | Dates use UTC (`toISOString().slice(0,10)`): bills made 00:00–05:30 IST are filed under **yesterday**. Daily totals are wrong for early-morning wholesale trade. |
| 6 | High | Bill save is not atomic: bill insert and N stock updates are separate writes; a failure midway leaves stock wrong. |
| 7 | High | Counter ID taken from the `x-counter` header — any client can claim to be any counter. |
| 8 | High | Cloud mode needs internet for every bill; no offline queue. LAN-local server not supported with shared DB. |
| 9 | Medium | Double-click / retry can create two bills (no idempotency key). |
| 10 | Medium | `/api/bills` and `/api/summary` load **every bill** into memory and sort in JS — will slow down within months on a 4 GB Celeron. |
| 11 | Medium | Credit sales record only a customer name — no customer master, no balance, no limit. |
| 12 | Medium | WhatsApp window opens on every save, even with no phone number. |
| 13 | Medium | Manager rate changes reach counters only when they reload products (after a save). |
| 14 | Medium | SSE token passed in URL query string (ends up in logs). |
| 15 | Low | Rate stored as integer paise but `Math.round(+b.rate)` — fine; however `discount` is a flat ₹ only; no % and no per-line discount. |
| 16 | Low | Backups only in Single-PC mode; nothing for cloud mode. |
| 17 | Low | Shop name/address hard-coded in `App.jsx` (`SHOP` constant). |
| 18 | Low | Emoji on thermal receipts (many printers can't print them). |

---

## B. Gap analysis

Legend: ✅ EXISTS · 🟡 PARTIAL · ❌ MISSING · 🔧 NEEDS REFACTOR

| § | Requirement | Status | Note |
|---|---|---|---|
| 3 | Local-first, LAN server, works without internet | ❌ | Cloud mode is internet-only |
| 4 | Roles SUPER_ADMIN/OWNER/MANAGER/OPERATOR + permissions | 🟡 | Only MANAGER/OPERATOR, role string checks |
| 5 | Terminal registration & status | ❌ | Counter name only, self-declared |
| 6 | Login (username+password/PIN, attempts logged) | 🟡 | Two cards by role; no PIN; failures not persisted |
| 7 | Dense POS screen | 🔧 | Two-column card layout, large whitespace, select dropdown |
| 8 | Central configurable shortcuts | 🔧 | Single listener inside Billing; F1–F3, F7–F12, Ctrl keys missing |
| 9 | Focus management | ❌ | Mouse needed for product/payment |
| 10 | Product master (code, barcode, local name, category, GST, HSN…) | 🟡 | name/unit/rate/stock/code only; units KG/PCS only |
| 11 | Fast product search | ❌ | `<select>` dropdown |
| 12 | Scale integration with adapters | 🟡 | Real serial + generic parser; needs adapter interface, test/read buttons, per-terminal config |
| 13 | Manual weight with source recorded | 🟡 | Works in browser only (`prompt()` bug), source recorded |
| 14 | Decimal-safe calculation, tax, rounding | 🟡 | Integer paise ✅; no tax; rounding fixed to ₹1 |
| 15 | Real-time price push | ❌ | |
| 16 | Price history | 🟡 | Stored, not viewable; no effective-from time |
| 17 | Invoice snapshot | ✅ | Add tax-rate snapshot & product code |
| 18 | Open-bill price rule | 🟡 | Lines keep rate naturally; no notification |
| 19–20 | Customer master & ledger | ❌ | Free-text name only |
| 21–22 | Supplier & purchases | ❌ | |
| 23 | Inventory ledger | ❌ | Single `stock` number, no movement history |
| 24 | Wastage | ❌ | |
| 25 | Bill structure & statuses | 🟡 | COMPLETED/CANCELLED only |
| 26 | Concurrency-safe numbering | 🟡 | Atomic $inc ✅, but not in a transaction with the bill |
| 27 | Hold/resume | ❌ | |
| 28 | Payment modes incl. mixed, change due | 🟡 | CASH/UPI/CREDIT single mode |
| 29 | Credit limit check | ❌ | |
| 30 | Printing 58/80/A4, silent print | 🟡 | 80 mm via dialog |
| 31 | Reprint control & log | 🟡 | Anyone can reprint; not logged; no DUPLICATE mark |
| 32 | Returns | ❌ | |
| 33 | Cancellation workflow | 🟡 | Works in browser; `prompt()` bug in Electron |
| 34 | Discount limits & manager override | ❌ | |
| 35 | Manager dashboard | 🟡 | Summary tiles only |
| 36 | Live bill monitor | ❌ | |
| 37 | Reports | 🟡 | One summary; no product/operator/GST etc.; no export |
| 38 | Cash sessions/shift | ❌ | |
| 39 | Audit log | 🟡 | Free text; no old/new values, terminal, viewer |
| 40 | Socket.IO events | ❌ | |
| 41 | Network failure handling | 🟡 | Error messages only |
| 42 | Cloud sync queue | ❌ | |
| 43 | Owner remote dashboard | 🟡 | Hosted-mode browser access exists (insecure path via shared DB) |
| 44 | Multi-branch-ready IDs | ❌ | |
| 45–46 | Settings & hardware screens | 🟡 | Scale screen only |
| 47 | Backup/restore | 🟡 | NeDB file copy only |
| 48 | Relational entities | ❌ | |
| 49 | Transactions | ❌ | |
| 50 | Concurrency | 🟡 | |
| 51–52 | Desktop UI, low-spec performance | 🔧 | |
| 54 | Security hardening | 🟡 | See bugs 1, 2, 3, 7, 14 |
| 56 | Tests | ❌ | None |

---

## C. Database decision & plan

**Decision: migrate to PostgreSQL on the shop server PC.** Keep MongoDB/NeDB code only for a one-time import.

Why migration is justified (not just preference):
- Billing completion must atomically write invoice + lines + payments + stock movements + customer ledger + audit. PostgreSQL transactions do this simply; the current code has none.
- Ledgers, stock ledgers, GST and counter-wise reports are relational aggregate queries — SQL with indexes vs. loading all bills into JS memory today.
- Foreign keys / unique constraints / `CHECK` constraints stop bad data at the database.
- The local-first requirement needs a database **inside the shop**. Running PostgreSQL on one PC is a standard Windows install (~60 MB RAM idle), lighter than a local MongoDB replica set (needed for Mongo transactions).

Migration path: `server/db/import-legacy.js` reads the existing Atlas or NeDB data (users, products, bills, rate history, audit) and inserts into PostgreSQL, preserving bill numbers, rates, and the per-counter sequences. Read-only on the source.

Schema conventions:
- UUID primary keys (generated server-side; safe for offline/sync/multi-branch).
- Every business table carries `branch_id` (single branch seeded now) → multi-branch later without migration pain.
- Money: `BIGINT` paise. Weight: `BIGINT` grams (or milli-units). Quantities stored as integer milli-units (`qty_milli`) so PCS, KG, LITRE all share one column.
- Timestamps `timestamptz`; business date computed in `Asia/Kolkata` (fixes bug 5).
- Soft delete / status for masters and financial records; never hard-delete invoices.
- Versioned SQL migrations in `server/db/migrations/NNN_name.sql`, applied by `server/db/migrate.js` with a `schema_migrations` table.

Tables (first migration): organizations, branches, terminals, users, roles, role_permissions, user_sessions, categories, units, products, price_history, customers, customer_ledger, suppliers, supplier_ledger, purchases, purchase_items, invoices, invoice_items, payments, returns, return_items, inventory_transactions, wastage, cash_sessions, held_bills, doc_sequences, idempotency_keys, sync_queue, audit_logs, settings, backups.

---

## D. Network architecture

```
             MANAGER PC  (app in MANAGER mode; can also be the server)
                  │ LAN (HTTP + Socket.IO on :4310)
   ┌──────────── SHOP SERVER (app in SERVER mode, or Windows service) ─────────┐
   │  Express API + Socket.IO  ──  PostgreSQL 16 (localhost only)               │
   │  daily pg_dump backup  ──  optional cloud-sync worker (outbound HTTPS only)│
   └────────────────────────────────────────────────────────────────────────────┘
        │            │            │            │
    COUNTER-01   COUNTER-02   COUNTER-03   COUNTER-04   (app in TERMINAL mode)
    Electron main process = "hardware agent": scale (serialport) + printer
    Renderer talks to server over LAN; to scale/printer only via preload IPC
```

- Counter PCs hold **no database credentials**. They register with the server using a one-time terminal enrolment code issued by the manager; the server issues a terminal key stored in the OS user-data folder.
- PostgreSQL listens on `127.0.0.1` of the server PC only; counters reach the API, never the DB.
- Internet loss affects only cloud sync/backup. LAN loss shows **SERVER DISCONNECTED**; open bills stay in memory and are retried with the same idempotency key, so nothing duplicates. (Full offline invoicing on a counter while the server is down is Phase 18 — see Risks.)
- After every Socket.IO reconnect the client re-fetches products/prices, so missed events can't leave stale rates.

---

## E. Implementation plan (phases, each leaves the app runnable)

| Phase | Deliverable |
|---|---|
| 1 | This audit |
| 2 | PostgreSQL schema + migrations, DB layer, legacy importer, server split into modules, config from env (no secrets in renderer) |
| 3 | Auth + RBAC (permission matrix, PIN login, sessions, lockout persisted, manager override PIN) |
| 4 | Terminal enrolment, heartbeat, status |
| 5–6 | Products/categories/units, price change with effective time, history, `product:price-updated` |
| 7 | New dense keyboard-first POS screen, central shortcut registry, focus engine |
| 8 | Scale adapter architecture in Electron main (generic, ST/GS, configurable regex), test/read/connect |
| 9 | Payments (cash/UPI/card/bank/credit/mixed, change due) |
| 10 | Printing: 58/80 mm + A4 templates, silent print via Electron `webContents.print`, reprint log + DUPLICATE |
| 11 | Customers + ledger + credit limits |
| 12 | Suppliers + purchases |
| 13 | Inventory ledger, adjustments, wastage |
| 14 | Returns, cancellations |
| 15–16 | Manager dashboard, live bill monitor, counter status via Socket.IO |
| 17 | Reports + CSV/print export |
| 18 | Backup/restore (pg_dump), sync_queue + cloud push worker |
| 19 | Automated tests: concurrency (4 parallel counters), price-change rule, returns, permissions |
| 20 | Packaging (electron-builder), setup docs |

---

## F. Files that will change
`package.json`, `main.js`, `preload.js`, `setup.html`, `vite.config.mjs`, `client/index.html`, `client/src/main.jsx`, `client/src/styles.css`, `server/index.js` (becomes a thin entry), `README.md`, `SETUP.md`, `.env.example`, `.gitignore`, `make-config.js` (stops bundling DB credentials), `Dockerfile`.
`client/src/App.jsx` is replaced by modules under `client/src/` (old file kept as `App.legacy.jsx` until the new POS is accepted).

## G. New files (main ones)
```
server/config.js  server/db/{pool,migrate,import-legacy,seed}.js  server/db/migrations/001_init.sql
server/auth/{rbac,middleware}.js  server/realtime.js  server/lib/{money,dates,errors,audit,sequence}.js
server/routes/{auth,terminals,products,customers,suppliers,purchases,invoices,returns,inventory,cash,reports,settings,backup,audit}.js
electron/{hardware/scale/*.js, printer.js, ipc.js}
client/src/{api,socket,shortcuts,focus}.ts  client/src/pos/*  client/src/manager/*  client/src/components/*
tests/*.test.js   docs/{API,DATABASE,SHORTCUTS,PERMISSIONS,SETUP-*,TROUBLESHOOTING}.md
```

## H. Packages
Add: `pg`, `socket.io`, `socket.io-client`, `zod` (validation), `helmet`, `express-rate-limit`, `typescript` (dev), `@types/react` (dev). Keep: express, bcryptjs, jsonwebtoken, serialport, electron, vite, react. Keep `mongodb` + `@seald-io/nedb` only for the importer.
No UI framework, no chart library, no animation library (low-spec target).

## I. Risks
1. **PostgreSQL install** on the server PC is a new setup step (one-time, documented).
2. **Scale protocol** — your scale's exact output format is unknown; the adapter supports common formats and a configurable pattern, but needs one test on the real scale (send model/manual).
3. **Silent printing** depends on the Windows printer driver; ESC/POS raw mode needs the printer model.
4. **Counter offline billing when the server PC is down** needs provisional numbering and later reconciliation; this is the riskiest feature for duplicates and is scheduled last, after the core is stable.
5. **Existing Atlas data** must be imported once; old bills remain readable.
6. Running the server on the manager PC means that PC must stay on during business hours.
7. The 4 GB Celeron target: renderer budget kept under ~150 MB; lists paginated; no heavy libraries.
