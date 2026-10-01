# Unique Basket Billing – Complete Setup (cloud database, no Render)

## How it works
Every shop PC runs this app. All PCs read and write ONE cloud database (MongoDB Atlas).
Products, rates, stock, users and every bill are stored in the cloud. The manager logs in on any PC
and sees ALL counters together (Bills & Reports, Counter column). The weighing scale and printer stay on each PC.
No server to deploy, no Render. Needs internet while billing.

## PART 1 – Cloud database (once, 10 minutes)
1. Go to https://www.mongodb.com/atlas , sign up, create a FREE cluster (M0).
2. Security > Database Access > Add user: username `basket`, password letters+numbers only (e.g. `Basket7788Shop`),
   role "Read and write to any database".
3. Security > Network Access > Add IP Address > "Allow access from anywhere" (0.0.0.0/0) > Confirm.
4. Database > Connect > Drivers > copy the connection string:
   mongodb+srv://basket:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority
   Replace <password> with your password.

## PART 2 – Project on your main PC
1. Install Node.js 20 LTS (nodejs.org) and VS Code. Unzip this project, e.g. D:\wholesale-billing-desktop.
2. Open the folder in VS Code (File > Open Folder).
3. Open the file `.env` and set:
   MONGO_URI  = your connection string from step 4
   ADMIN_PASSWORD = the manager password you want (8+ characters)
   Save (Ctrl+S).
4. Double-click `1-install.bat` (or terminal: npm install). Wait until it finishes.
5. Double-click `2-test-cloud-connection.bat`. You must see:  MONGO CONNECTED
   (If not: bad auth = wrong password | ENOTFOUND = wrong cluster address | timeout = Network Access step 3.)
6. Double-click `3-run-app.bat` (or terminal: npm start).
7. First screen "PC Setup": keep "Cloud PC", counter name C1, Save & Start.
8. Login on the MANAGER card: manager / your ADMIN_PASSWORD.
9. Manager > Users: create operator logins. Manager > Products: add products and rates.
   Manager > Scale: choose Mock (testing) or Serial (real scale: COM port, baud rate from the scale manual).

## PART 3 – Install on the other PCs
1. On the main PC double-click `4-build-installer-exe.bat` (or npm run dist). It needs the real MONGO_URI in .env.
   Result: dist\Wholesale Billing Setup 2.0.0.exe   (cloud address is bundled inside)
   If Windows shows a symbolic-link error: Settings > For developers > Developer Mode ON, then run again.
2. Copy that one .exe to each PC (USB / Dropbox) and install it. Windows SmartScreen: More info > Run anyway.
3. First screen: keep "Cloud PC", enter counter name (C2, C3, ...), Save & Start.
4. Login with an operator or the manager created in step 2.9.
5. On each PC: Manager login > Scale > set THAT PC's COM port. (Scale settings are saved per PC, not in the cloud.)

## PART 4 – Owner / admin view
Login with the MANAGER card on any PC > Bills & Reports: pick a date; see sales, cash, UPI, credit, kg sold,
and every bill from all counters (Counter column). Also Products, Users, audit data. To inspect raw data:
Atlas > Database > Browse Collections > uniquebasket.

## Daily rules
- Bill numbers: INV/2026-27/C1-000001, C2-000001 ... unique per counter.
- Operators cannot change rates or enter manual weight (Manager only). The app enforces this on every request.
- Forgot manager password: set a new ADMIN_PASSWORD in .env and double-click `5-reset-manager-password.bat`.
- Change a PC's role/counter: delete %APPDATA%\wholesale-billing-desktop\config.json and reopen.

## Security
- The cloud address (with its password) is inside .env and inside the installer. Treat both as private; install only on shop PCs.
- Atlas user: give it only this database if possible. If the password ever leaks, change it in Atlas and rebuild the installer.
- Better: Atlas > Network Access > allow only your shop's public IP instead of 0.0.0.0/0 (if your internet IP is fixed).
- Turn on Atlas backups (Cluster > Backup) for a paid tier, or export regularly.

## Limits (honest)
- NO internet = NO billing in Cloud PC mode (a PC cannot reach the database). Use a reliable connection / a second SIM hotspot.
  Offline queue (bill offline, upload later) is not built yet. "Single PC (offline)" mode works with no internet but keeps its own separate data.
- Scale: generic serial reader (e.g. "ST,GS,+024.650kg"). Confirm with your scale model's manual.
- Printer: Windows print dialog (80mm receipt). Thermal printers may not print emoji: set icons:false in client/src/App.jsx (SHOP line).

## OPTION B – run the backend itself on a cloud host (instead of on each PC)
Needs a hosting service (Railway, Google Cloud Run, Fly.io, a VPS ...). The included Dockerfile works on any of them.
Set environment variables there: MONGO_URI, MONGO_DB, ADMIN_PASSWORD (start command: node cloud.js).
Then on each PC choose "Counter -> hosted server" in PC Setup and paste the https address.
