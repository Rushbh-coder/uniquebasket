# PROMPT — Multi-Branch + Offline-First Billing + Cloud Sync + Admin (HQ) Site

Copy everything below the line into your AI coding assistant (VS Code Copilot / Claude / Codex) with the
`wholesale-billing-desktop` folder open.

---

You are a senior architect and engineer for Electron, Node.js/Express, React, MongoDB, distributed offline-first
systems, data synchronisation, POS/billing and security.

The project open in this workspace is an EXISTING, WORKING multi-counter billing system (v3). Do NOT rewrite it.
Extend it. Read the code and the docs first (README.md, SETUP.md, docs/*.md, server/**, client/src/**, main.js).

## 0. Working rules (must follow)

1. Analyse the existing code first and give me a short plan + list of files you will change/create BEFORE coding.
2. Reuse the existing architecture:
   - `server/db/index.js` → `db.tx()` (serialised, journaled, crash-safe transactions). Every multi-document write
     (including writing to the sync outbox) MUST happen inside the same `db.tx()` as the business change.
   - `server/db/migrate.js` → add new numbered migrations; never break existing data.
   - `server/services/*` (business logic), `server/routes/api.js`, `server/auth/rbac.js` (permissions),
     `server/realtime.js` (SSE events), `client/src/lib/shortcuts.js` (single shortcut registry).
   - Money = integer paise, weights = integer grams. Never floats.
3. Do not remove working features. Do not rename existing collections/fields/APIs without a migration.
4. Billing must NEVER stop because of internet problems. Internet is used only for sync and the HQ admin site.
5. Never put cloud/database secrets in the renderer or in the installer. Branch servers authenticate to the cloud
   with their own branch API key stored encrypted (Electron safeStorage), issued by enrolment like counters.
6. Every sync operation must be idempotent (safe to repeat), ordered where needed, and resumable after
   power cut / crash / network drop. No duplicate invoices, no lost invoices, no double stock movement.
7. Keep the app fast on Celeron / 4 GB RAM Windows PCs. Sync runs in the background and must not slow billing.
8. Add automated tests for everything (extend `tests/api.test.js` style; add new test files). All existing tests
   must keep passing.
9. Keep the app runnable after each phase. Update docs at the end of each phase.
10. Clearly list anything not finished.

## 1. Target business setup

- One business (organisation) with **2 branches now**, designed for N branches later.
  Example: BR1 Rajkot, BR2 Surat.
- Each branch: 1 Manager PC (branch server, local MongoDB) + 4 counter PCs + scales + printers, on the shop LAN.
- 1 Cloud HQ (cloud server + cloud MongoDB, e.g. MongoDB Atlas + Render/Railway/VPS/Docker).
- HQ Admin / Owner opens the **Admin Site** in a browser from anywhere (laptop/phone).

```
                 HQ ADMIN SITE (browser, anywhere)
                              │ HTTPS
                 ┌────────────┴─────────────┐
                 │ CLOUD HQ API + cloud DB  │  (all branches' data, admin commands)
                 └────┬─────────────────┬───┘
          sync (HTTPS, when internet)   sync (HTTPS, when internet)
                      │                 │
        ┌─────────────┴──────┐  ┌───────┴────────────┐
        │ BR1 branch server  │  │ BR2 branch server  │   local MongoDB = source of truth
        │ (manager PC)       │  │ (manager PC)       │   for billing in that branch
        └──┬───┬───┬───┬─────┘  └──┬───┬───┬───┬─────┘
           C1  C2  C3  C4 (LAN)     C1  C2  C3  C4 (LAN)
```

## 2. Offline guarantees (the most important requirement)

| Failure | Required behaviour |
|---|---|
| Internet down at a branch | Operators AND manager keep billing, payments, returns, stock, reports, price changes — everything local. Sync queue grows; uploads automatically when internet returns. |
| Cloud server down | Same as above. |
| Branch manager PC / LAN down (counter cannot reach branch server) | **Counter offline mode**: counter keeps billing locally (see §6), uploads to the branch server when it is back. |
| Power cut mid-bill / mid-sync | Nothing half-saved (existing tx journal), sync resumes from last confirmed point. |
| Admin changes something while a branch is offline | Change is queued in the cloud and applied when the branch reconnects; admin sees "Pending at BR2". |

Show clear status everywhere: `SERVER CONNECTED / DISCONNECTED`, `CLOUD SYNC: OK / PENDING (n) / OFFLINE since hh:mm / ERROR`.

## 3. Data model changes (via migrations)

1. Add `organizations` and `branches` collections. Each branch: `branchId` (e.g. `BR1`), name, address, GSTIN,
   state, timezone, invoice prefix, status, cloud enrolment info.
2. Add `branchId` (and `orgId`) to every business document: users (home branch + allowed branches), terminals,
   products (see pricing rules), product prices, customers, suppliers, bills, bill items, payments, returns,
   inventory movements, purchases, ledgers, held bills, cash sessions, audit, settings (branch-level).
   Migration: stamp existing data with the current branch (configured in PC Setup / Settings, default `BR1`).
3. Globally unique IDs: all NEW documents get globally unique ids (UUID v4 or ULID) so data from different branches
   never collides in the cloud. Existing 24-hex ids remain valid (they are random) — keep them.
4. Invoice numbers must be unique across branches: `INV/<BRANCH>/<FY>/<SERIES>-000001`
   (e.g. `INV/BR1/2026-27/C2-000123`). Old numbers stay as they are.
5. Every syncable document gets: `updatedAt` (server time), `version` (integer, +1 per change),
   `originBranch`, `deleted` (soft delete / tombstone — never hard delete).
6. New collections: `sync_outbox` (changes to send), `sync_inbox` / applied-commands log, `sync_state`
   (cursors, last success, last error, counts), `admin_commands` (cloud side), `branch_heartbeats` (cloud side).

## 4. Sync design (branch ⇄ cloud)

### 4.1 Push: branch → cloud (outbox pattern)
- Every business change writes a row to `sync_outbox` **inside the same `db.tx()`** as the change:
  `{ seq (monotonic per branch), entity, entityId, op: upsert|delete, version, payload snapshot, createdAt, status }`.
- A background worker on the branch server sends outbox rows in batches (e.g. 200 rows, gzip) to
  `POST /cloud/sync/push` over HTTPS with the branch API key + HMAC signature + idempotency key per batch.
- Cloud upserts each row by `(branchId, entity, entityId)` only if `version` is newer (idempotent, out-of-order safe),
  then returns the highest `seq` stored. Branch marks rows `SYNCED` up to that seq.
- Retry with exponential backoff (5s → 10 min max), resume after restart, never block billing.
- Rows that fail validation go to a dead-letter state with the error, shown in Admin + branch Sync page; retry button.
- Keep synced outbox rows 30 days then purge.

### 4.2 Pull: cloud → branch (commands + master data)
- Branch polls `GET /cloud/sync/pull?cursor=` every 15-30 s when online (and immediately on reconnect); optional
  SSE/WebSocket push from cloud for faster delivery.
- Receives: admin commands for that branch + shared master data (global products, HQ price lists, HQ users).
- Each command has `commandId`; branch applies it inside `db.tx()`, records it in the applied log (so repeats are
  ignored), creates audit row "by <admin> via HQ", emits the normal realtime events to its counters, and acknowledges
  with result (`APPLIED` / `REJECTED: reason`). Cloud shows status to the admin.
- Commands expire if not delivered within a configurable time (e.g. price changes 24 h) and are shown as EXPIRED.

### 4.3 Conflict rules (write them in code + docs)
| Entity | Authority / rule |
|---|---|
| Bills, payments, returns, cancellations, stock movements, ledger rows | Immutable / append-only. Branch is the only author. No conflicts possible. Cancel/return from HQ = a command executed by the branch. |
| Stock quantity | Never synced as a number to overwrite; derived from movements. Cloud recalculates per branch from movements. |
| Product master (name, code, unit, GST, HSN) | Global master owned by HQ; branches may add local products (marked local) that HQ can see. |
| Sale rates | Support BOTH: global rate (HQ) and branch-specific rate override. Branch manager can change its own branch rate (if permitted); HQ can change for one/many/all branches. Newest effective time wins; keep full price history per branch. Old bills never change. Open-bill rule stays (lines keep quoted rate). |
| Customers | Branch-owned by default (customer belongs to a branch, outstanding per branch). Optional "shared customer" flag. Field-level last-writer-wins with audit. |
| Users / roles | HQ owns HQ_ADMIN/OWNER users; branch manager manages branch users. Changes sync both ways with version check. |
| Settings | Org-level (HQ) + branch-level; branch-level wins for branch items (printer, scale never synced). |

### 4.4 Time & ordering
- Never trust PC clocks for ordering: use `seq` and `version`; store both device time and server time; warn if a
  PC clock is wrong by > 5 minutes (affects business date).

### 4.5 Initial sync / new branch / reinstall
- First connection uploads full history in pages with progress bar (resumable).
- A new or rebuilt branch server can download its own branch data back from the cloud (disaster recovery).

## 5. Cloud HQ server

- Node.js + Express (reuse the existing server code/modules where possible) + MongoDB Atlas (or any MongoDB).
  Docker image + `.env.example`; deploy guide for Render/Railway/VPS.
- Endpoints: branch enrolment (one-time code → branch API key), `/cloud/sync/push`, `/cloud/sync/pull`,
  `/cloud/sync/ack`, branch heartbeat, admin APIs, admin auth.
- Security: HTTPS only, branch API key + HMAC request signing + timestamp/nonce (replay protection), rate limits,
  input validation, per-branch data isolation, admin 2-step login (password + PIN/OTP optional), audit of every admin
  action, no direct DB exposure, secrets only in server env.
- Indexes on `(branchId, date)`, `(branchId, entity, entityId)`, etc. Daily cloud backups.

## 6. Counter offline mode (branch server / LAN down)

- Each counter's local service keeps a local cache (NeDB) of products, prices, customers (needed fields), settings,
  and a local bill queue.
- When the branch server is unreachable, the counter switches automatically to OFFLINE MODE (big orange banner),
  operator continues billing with the same screen and shortcuts.
- Offline invoice numbers must still be unique: branch server pre-allocates a **reserved number block** per counter
  (e.g. 200 numbers, refilled when online) so offline bills get final numbers immediately; if the block is exhausted,
  use provisional `OFF-<COUNTER>-<seq>` and assign the final number on upload (both shown on bill reprint).
- Limits in offline mode (configurable): no credit sale over limit without later approval flag, manager approvals by
  local manager PIN cache (hashed, short validity), no returns/cancellations of bills from other counters.
- On reconnect: upload queued bills in order with their idemKeys (exactly once), update stock/ledger on the branch,
  then branch syncs to cloud. Show "Uploading 12 offline bills…" and any rejected item clearly.

## 7. HQ Admin Site (web, responsive, works on phone)

1. Login (HQ_ADMIN / OWNER), branch selector: **All branches / BR1 / BR2**.
2. Dashboard: today's sales, bills, cash/UPI/card/credit, returns, discounts, outstanding, purchases, low stock —
   per branch + total; branch comparison table; counter status per branch; **sync status per branch**
   (online/offline, last sync time, pending rows, errors).
3. Live bill monitor across branches (branch, counter, operator, amount, mode, status) — near real time.
4. Reports (all existing reports) with branch filter / compare branches / consolidated; Excel/CSV/PDF export.
5. Products & rates: global product master, branch-specific rates, change rate for one/selected/all branches,
   schedule effective time, price history per branch, command delivery status per branch.
6. Stock per branch, stock transfer between branches (transfer out at BR1 → transfer in at BR2, both as
   movements, in-transit state) — optional phase.
7. Customers & outstanding per branch; supplier payables per branch.
8. Users & roles across branches (create branch managers/operators, disable users, reset PINs).
9. Bill actions: view any bill, request cancel / approve return at a branch (executed as a command with reason).
10. Audit log across branches (who, what, where, when, old/new values, via HQ or local).
11. Alerts: branch offline > X minutes, sync errors, large discounts, many cancellations, cash shift differences.
12. Data shown in the admin site always says "as of <last sync time>" for each branch.

## 8. Roles (extend `server/auth/rbac.js`)

- `HQ_ADMIN` / `OWNER`: all branches. `BRANCH_MANAGER` (= existing MANAGER) : own branch only.
  `OPERATOR`: own branch counters only. `ACCOUNTANT` (HQ or branch scope), `AUDITOR` (read-only all branches).
- Every API checks both permission AND branch scope. Tests must prove a BR1 manager cannot see/change BR2 data.

## 9. Branch-side screens to add

- Settings → Branch: branch id/name (set once), cloud server address, enrolment code, connect/disconnect.
- Sync page: status, last push/pull, pending count, error list with retry, "Sync now", initial upload progress.
- Status bar: cloud sync indicator next to SERVER CONNECTED.

## 10. Tests (must be automated and passing)

1. Internet down at BR1 for 2 hours: 4 counters bill 400 bills → reconnect → all 400 in cloud exactly once, totals match.
2. Kill the branch server process in the middle of a sync batch → restart → no loss, no duplicates.
3. Same batch sent twice / out of order → cloud state correct (idempotent, version check).
4. HQ changes Tomato rate for BR1 + BR2 while BR2 offline → BR1 applied live, BR2 pending → BR2 reconnects → applied,
   counters updated, old bills unchanged, open-bill lines keep quoted rate.
5. Branch manager changes branch rate while HQ changes global rate → documented rule decides, both histories kept.
6. Counter offline mode: LAN cut, counter bills 30 bills with reserved numbers → LAN back → uploaded once, stock correct.
7. Reserved block exhausted → provisional numbers → final numbers assigned on upload.
8. Branch scope: BR1 manager cannot read/modify BR2 data (API returns 403).
9. HQ cancel-bill command on an offline branch → executed after reconnect → stock & ledger reversed once.
10. Cloud restore / new branch PC: branch data downloaded back from cloud, billing continues with correct next numbers.
11. Clock wrong on a PC → warning, ordering still correct.
12. Load: 2 branches × 4 counters × 1,000 bills/day sync within normal time on low-spec PC.

## 11. Implementation phases (deliver in this order, app runnable after each)

1. Branch identity + migrations (branchId everywhere, new invoice format, global ids). Tests.
2. Outbox written inside every `db.tx()` + local Sync page (no cloud yet). Tests.
3. Cloud HQ server: enrolment, push endpoint, storage, idempotency, Docker + deploy docs. Tests.
4. Push worker on branch (retry, backoff, resume, dead letter). Tests incl. crash/offline scenarios.
5. Pull + admin commands (price change, product, user, cancel/return) with acknowledgements. Tests.
6. HQ Admin Site (dashboard, monitor, reports, products/rates, users, bills, audit, sync status, alerts).
7. Branch-specific pricing + conflict rules finalised. Tests.
8. Counter offline mode with reserved number blocks. Tests.
9. Initial upload / disaster-recovery download. Tests.
10. Security hardening, load test, documentation, packaging.

## 12. Deliverables

- Source code + migrations + tests (all passing) + Docker/deploy files for the cloud server.
- Updated `.env.example` (branch server) and `cloud/.env.example` (cloud server).
- Docs: architecture diagram, sync protocol & conflict rules, cloud deployment, branch enrolment, admin site guide,
  offline mode guide, disaster recovery, troubleshooting, API reference, permission matrix, list of unfinished items.

## 13. Definition of done

- Operators and manager at both branches bill normally with internet OFF; everything appears in the cloud admin
  site within 1 minute after internet returns, exactly once, totals matching each branch's own reports.
- Admin sees both branches separately and combined, and can change rates / manage products & users /
  cancel or approve returns for one or both branches; offline branches receive the changes on reconnect.
- Counters keep billing even when their branch server is down, and nothing is lost or duplicated after recovery.
- All tests pass; nothing in the installer contains secrets.
