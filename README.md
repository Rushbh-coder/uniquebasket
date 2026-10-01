# Wholesale Billing – Desktop App (Electron + Express + React + embedded MongoDB-style DB)

## Run (Windows / Mac / Linux)
1. Install Node.js 20 LTS: https://nodejs.org
2. Open this folder in VS Code (File > Open Folder), then Terminal > New Terminal
3. `npm install`     (first time only, needs internet once)
4. `npm start`       (builds the screens and opens the desktop app)

Browser mode without Electron: `npm run web` then open http://127.0.0.1:4310
Windows installer (.exe): `npm run dist`  -> output in `dist/` (build it on Windows)

## Logins (change passwords after first login: Manager > Users)
Manager  : manager  / manager123
Operator : operator / operator123

## Offline
Everything (app, database, scale) runs on this PC. Internet is never needed after step 3.
Data folder: Windows %APPDATA%/wholesale-billing-desktop/data  (copy this folder = backup)

## Weighing scale
Manager > Scale. "Mock" = simulator for testing. "Serial" = real scale on COM port
(set COM port, baud, data/stop bits, parity to match the scale manual). Generic parser reads lines such as
`ST,GS,+024.650kg`, `24.650 kg`, `12 pcs`. Some scales use another format: send us the model + manual and
adjust `onLine()` in server/index.js.
Units: KG products use weight; PCS products use scale count (or weight / piece-weight) or typed quantity.
Auto-capture: tick it on the Billing screen; a stable weight is added automatically, next item after scale empties.
