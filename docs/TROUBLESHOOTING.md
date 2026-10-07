# Troubleshooting
| Message / problem | Cause → fix |
|---|---|
| SERVER DISCONNECTED (counter) | Manager PC off/asleep, LAN cable, IP changed, firewall. Ping the manager PC; allow TCP 4310 on Private network; set Windows power plan "never sleep". The open bill stays on screen. |
| "This counter is not registered or was disabled" | Counter was disabled or re-enrolled. Manager → Counters → New enrolment code → PC Setup on the counter. |
| "Could not open the shop database" (manager PC) | MongoDB service stopped: Services → MongoDB → Start. Atlas: check internet / Atlas IP access list. |
| Scale DISCONNECTED / Port already in use | Wrong COM / other program holds it / cable. Hardware → ports list, close vendor software. |
| Scale weight wrong (×1000, never stable) | Wrong protocol or unit. Hardware → Last raw lines → Test format; set Stable after N readings = 2. |
| Weight added as MANUAL though scale is connected | Simulator in production, or the scale reading changed after capture. Use real scale; Settings → simulator off. |
| "Printer not available. Bill is saved." | Printer off / paper / wrong name in Counters. Fix, then F10. |
| Discount / manual weight asks for manager | Above the operator limit — by design. Manager types username + PIN. |
| "Customer credit limit exceeded" | Raise limit (Customers) or manager PIN (if policy BLOCK). |
| "Insufficient stock" | Settings → "Allow sale when stock is 0" is off; enter purchase / stock adjustment. |
| Login locked | 5 wrong attempts → 5 minutes. Manager → Users → Unlock. |
| Totals differ between screen and bill | The server is authoritative (rounding/discount allocation); report with the bill number. |
| Logs | `%APPDATA%\wholesale-billing-desktop\data\logs\server.log` |
