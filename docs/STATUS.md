# Status (v3.0.0)

## Verified by automated tests (sandbox, in-memory DB)
`tests/api.test.js` — 18/18 pass: 4 counters × 10 simultaneous bills (40 unique numbers, exact stock), weight×rate paise math (18.450 kg × ₹32 = ₹590.40 → ₹590), old bill unchanged after price change, open-bill line keeps quoted rate / new line gets new rate / fake old rate rejected, scheduled price, duplicate submit → one invoice, manual weight + forged scale reading → manager PIN, discount limit + approval, mixed payment & change, credit sale/limit/ledger/receipt, partial return & cancel reversals, purchase/supplier payable/wastage/stock ledger, operator permission denials, hold/resume across counters, cash shift difference, dashboard/reports/CSV/profit, disabled-user session end + lockout, backup→restore, rollback on failure (no partial bill, no stock change).
`tests/e2e-ui.mjs` — real Chromium, keyboard only: manager PC + separate counter PC (terminal mode through the LAN proxy), login by PIN, scale capture, counted item, manual weight + manager PIN, live price change toast while bill open, payment with change, silent print bridge, hold/resume, manager dashboard updates live, all manager pages open without errors.

## Not verified here (needs your PCs)
* Real **MongoDB** (sandbox had no MongoDB; adapter code uses standard driver calls) — run once on the manager PC.
* Real **express / bcryptjs / jsonwebtoken** packages (tests here used stand-ins because the sandbox blocks npm) — `npm test` on your PC runs the same suite with the real ones.
* Real **serial scale** and **thermal printer**, Electron packaging/installer, Windows firewall prompt.
* UI was built with React 19 in the sandbox; the project uses React 18 (same APIs used).

## Not built yet (honest list)
1. **Offline billing on a counter while the manager PC is down** (provisional numbers + later merge). Today the counter shows SERVER DISCONNECTED and keeps the open bill until the server is back.
2. **Cloud background sync** (sync_queue → cloud API) and the **owner remote dashboard**. Today: Atlas as DB, or VPN/hosted server, or off-site backup folder.
3. ESC/POS raw printing mode (uses Windows driver printing now), cash-drawer kick.
4. A4 GST invoice is basic (no e-invoice/IRN), no purchase returns screen (ledger types exist), no expense entry.
5. Branch-specific prices (data model ready, not exposed).
6. Customer payments received in cash are not yet added into the counter's shift cash.
7. TypeScript: the client stays in JSX (existing stack); no type-check step.
