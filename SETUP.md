# Shop setup (v3)

## 0. Before anything: secure the old installer
v2 put the MongoDB Atlas password inside `shop-config.json` and inside `Wholesale Billing Setup 2.0.0.exe`.
Change that Atlas user's password now (Atlas → Database Access), stop sharing the old .exe. v3 empties `shop-config.json`.

## 1. Manager PC (= shop server)
1. Give it a **fixed LAN IP** (router → DHCP reservation), e.g. `192.168.1.10`.
2. Install `Wholesale Billing Setup 3.0.0.exe` → PC Setup → **Manager PC / Shop server** → choose the shop database:
   * **Built-in database on this PC** (default): works without internet, nothing to install. Data files are in
     `%APPDATA%\wholesale-billing-desktop\data`. All data is held in memory, so it suits one shop's normal volume;
     for very large history move to MongoDB.
   * **MongoDB**: install **MongoDB Community Server** (Windows MSI, "Install as a Service") and leave the address blank.
     It listens on `127.0.0.1:27017` only — do not open it to the network. An Atlas address (`mongodb+srv://…`) also
     works, but then billing stops when internet stops.
3. Manager password (first start) · Bill series `C1` (keep if this PC billed with v2).

### Working without internet
Internet is needed by nothing except an Atlas database. With the built-in database (or MongoDB on the manager PC) the
manager PC and all counters bill over the shop network with the internet cable unplugged.
A PC that already uses Atlas: close the app, run `6-switch-this-pc-to-offline.bat` (needs internet once, to copy the
data down). The cloud data is only read. The old settings are kept as `config.before-offline-<time>.json` next to
`config.json`; copying that file back over `config.json` returns the PC to the cloud database.
Only one PC may own the shop data: other PCs must be **Counter PCs** of this manager PC, not connected to Atlas themselves.
4. Windows Firewall: allow inbound **TCP 4310** on *Private* networks (first start shows a prompt → Allow on private networks).
5. Existing v2 data: point it at the same database (v2 used `MONGO_DB=uniquebasket`). It is upgraded automatically.
   To move Atlas data to the local MongoDB once: `mongodump --uri "<atlas uri>" --db uniquebasket` then `mongorestore --db uniquebasket dump/uniquebasket`.

## 2. Create the counters (manager)
Manager → **Counters** → *+ Add counter*: Terminal ID `COUNTER-01`, Name, Bill series `C2` (each counter its own series),
paper 58/80mm/A4, printer name. An **8-character enrolment code** is shown (valid 7 days, single use).

## 3. Counter PC (operator)
1. Same LAN as the manager PC. Install the same .exe → PC Setup → **Counter PC**.
2. Server address `http://192.168.1.10:4310`, enrolment code from step 2 → Save & Start.
3. The counter now appears **ONLINE** in Manager → Dashboard / Counters.
4. Log in once as manager on that counter → **Hardware** → set the scale COM port for that PC (see docs/HARDWARE.md) → Test print.
A lost / replaced counter: Manager → Counters → *New enrolment code* (old key stops working immediately).

## 4. Users
Manager → **Users**: create `operator1…` (role OPERATOR) with password and a 4-6 digit **PIN** (fast login).
Give managers a PIN too — it is what they type on a counter to approve discounts, manual weights, cancellations.

## 5. Daily use
* Operator: login → bill (see docs/SHORTCUTS.md) → optional **Shift** open/close for cash counting.
* Manager: Dashboard (live), change rates (Products & Rates → *Rate*; can schedule a future time), reports, purchases, stock.

## 6. Backup & restore
* Automatic: every day at the time in Settings (default 23:30) on the server PC → `%APPDATA%\wholesale-billing-desktop\data\backups\backup-*.json.gz` (kept 30 days).
  Set `BACKUP_DIR` in `.env` to put them on a second disk / OneDrive / Google Drive folder (that is your off-site copy).
* **Backup now**: Manager → Backup. **Restore**: Manager → Backup → *Restore…* → type RESTORE + your password. A safety backup of the current data is taken first. Restart all counters after a restore.
* Additionally (MongoDB): `mongodump --db uniquebasket --out D:\mongo-backup\%date%`.

## 7. Network
* All PCs on the same router/switch (wired recommended). Counter ↔ manager traffic is plain HTTP inside the shop LAN; do **not** port-forward 4310 to the internet.
* Remote owner access later: use a VPN (e.g. Tailscale) to the manager PC rather than opening ports.
* If the LAN drops, counters show **SERVER DISCONNECTED**; the open bill stays on screen (and survives an app restart) and is saved with the same request id when the server is back — never twice.

## 8. Build the installer
On a Windows PC with Node 20: `npm install` → `npm run dist` → `dist\Wholesale Billing Setup 3.0.0.exe`.
If you see a symbolic-link error: Settings → For developers → Developer Mode ON. The installer contains **no** passwords.

## 9. Single PC (no network)
PC Setup → *Single PC*: uses the same files as v2 "Single PC" (`data\*.db`, NeDB). All features work on that PC.

## 10. Reset
* Forgot manager password (server PC): set `ADMIN_PASSWORD` in `.env` → `5-reset-manager-password.bat`.
* Change a PC's role: delete `%APPDATA%\wholesale-billing-desktop\config.json` and restart.
