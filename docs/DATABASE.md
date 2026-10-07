# Database (MongoDB; NeDB in single-PC mode)
Collections (v2 names kept): `users, products, bills, rates (price history), settings, audit` + new
`terminals, sessions, customers, customer_ledger, suppliers, supplier_ledger, purchases, inventory (stock ledger), held_bills, cash_sessions, returns, price_schedule, backups, migrations, tx_journal, sync_queue`.

**Units:** money = integer paise; KG/LITRE quantities = integer grams/ml; PCS/DOZEN/BOX/BAG/CRATE/BUNDLE = integer count. Rate = paise per kg / per piece. Amount = qty × rate ÷ 1000 (weighed), half-up rounding, never floating point.

**Invoice (`bills`)** keeps a full snapshot per line: productId, code, name, unit, qty, tare, gross weight, rate, rate source (MASTER/QUOTED/MANUAL), weight source (SCALE/MANUAL/COUNT), discount share, GST rate, taxable, tax, amount, purchase rate (owner-only). Changing a product later never changes old bills. Status: COMPLETED, CANCELLED, PARTIALLY_RETURNED, RETURNED (held bills live in `held_bills`; drafts stay on the counter). Bills are never deleted.

**Numbering:** `INV/<FY>/<series>-000001` per counter (or one global series). Sequence `settings._id = seq-<series>-<FY>` incremented inside the sale transaction; unique index on `no`; resets every April. v2 numbering continues.

**Transactions:** every multi-document change (sale, cancel, return, purchase, price change, stock adjust, payment) runs in `db.tx()`: one at a time on the server (no races between counters) and all-or-nothing — each write first stores an undo step in `tx_journal`; on error the steps are undone; after a crash/power cut they are undone on the next start. Works on standalone MongoDB (no replica set needed), Atlas and NeDB.

**Indexes:** users.username (unique), bills.no (unique), bills.idemKey (unique sparse), bills.date / at / customerId / terminalId+date, products.code & barcode (unique sparse), customers.mobile/code, ledgers by party+time, inventory by product+time and date, audit.at, terminals.code (unique), …

**Multi-branch ready:** IDs are server-generated strings; terminals have their own series; adding `branchId` to terminals/bills/products is an additive migration (`server/db/migrate.js`).

**Migration from v2** (automatic, `migrations` collection m1): products get weighable/priceVersion and an OPENING stock-ledger row; bills get payments[], terminalCode, IST business date; rate history gets product names; per-counter sequences are copied to the FY-based keys.
