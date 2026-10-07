# API (shop server, port 4310)
All bodies JSON; money in **paise** (integer), weights in **grams**, counted units as integers. Auth: `Authorization: Bearer <token>` from `/api/login`.
Counter PCs add `x-terminal-key` automatically (local service) — billing requires a registered counter. Errors: `{error, code, extra}`; `code: APPROVAL_REQUIRED` + `extra.action` means: get `/api/approve` and resend with `approvals: {<action>: token}`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | /api/health | — | status |
| POST | /api/login | — | {username, password or PIN} → {token, user} |
| POST | /api/logout, GET /api/me | user | |
| POST | /api/approve | user | {username, secret(PIN/pw), action, value} → {approval} (3 min) |
| GET | /api/config | user | shop, billing, discount limits, shortcuts |
| POST | /api/events/ticket → GET /api/events?ticket= | user | live events (SSE) |
| GET | /api/products | product.view | POS list (no purchase rate). `?all=1` full list for managers |
| POST/PUT | /api/products, /api/products/:id | product.edit | create / edit (rate changes via /price) |
| POST | /api/products/:id/price | price.edit | {rate, effectiveAt?, reason?} |
| GET | /api/products/:id/prices, /api/prices/history, /api/prices/scheduled | | price history / schedule |
| GET/POST/PUT | /api/customers[/:id] | customer.* | search `?q=`, create, edit |
| POST | /api/customers/:id/payments · GET …/ledger?from&to | customer.payment | receipts, statement |
| POST | /api/bills | bill.create | complete sale (see below) |
| POST | /api/bills/preview | bill.create | totals without saving |
| GET | /api/bills?date|from&to&status&terminal&no&limit | own / all | list |
| GET | /api/bills/:id | | detail |
| POST | /api/bills/:id/cancel | bill.cancel or PIN | {reason} |
| POST | /api/bills/:id/returns | bill.return or PIN | {items:[{line,qty}], refundMode, reason, idemKey} |
| POST | /api/bills/:id/printed | | {reprint, reason} (logged) |
| GET/POST | /api/held · POST /api/held/:id/resume | bill.hold | hold / resume |
| GET | /api/shift · POST /api/shift/open · /api/shift/close | cash.session | |
| * | /api/suppliers, /api/purchases, /api/stock/adjust, /api/stock/wastage, /api/stock/ledger/:productId | purchase/stock | |
| GET | /api/dashboard · /api/reports/:name?from&to&terminal&by[&format=csv] | dashboard / report.sales | reports: daily product category operator counter customer payment credit gst discount cancelled returns prices purchases suppliers stock lowstock wastage outstanding shifts profit |
| * | /api/users, /api/sessions, /api/terminals, /api/settings, /api/backups, /api/audit | manager | administration |
| POST | /api/terminals/enrol | enrolment code | counter enrolment |
| * | /api/scale/* | local PC | scale state/stream/config/test (served by each PC itself) |

**POST /api/bills** body:
```json
{ "idemKey": "unique-per-bill", "customerId": null, "customer": {"name":"","mobile":"","address":""},
  "items": [{ "productId": "…", "qty": 18450, "rate": 3200, "tare": 0, "reading": {"grams":18450,"at":"…","terminal":"COUNTER-01","sig":"…"}, "quotedAt": "ISO time line was added" }],
  "discount": {"type":"AMT|PCT","value":0}, "payments": [{"mode":"CASH","amount":59000}], "tendered": 100000, "approvals": {} }
```
Same `idemKey` sent twice returns the same invoice (`duplicate: true`).
Events: product:created/updated/price-updated/status-changed/price-scheduled, inventory:updated, bill:completed/cancelled/returned/held, terminal:online/offline, user:permission-updated, settings:updated, customer:updated/payment, purchase:created, shift:closed, data:restored.
