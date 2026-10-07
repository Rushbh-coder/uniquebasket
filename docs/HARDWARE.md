# Weighing scale & printer

## Scale (per counter PC: Manager login on that PC → Hardware)
Supported: RS-232 / USB-to-serial scales that send the weight as text. The parser is selectable:

| Protocol | Example output | Notes |
|---|---|---|
| generic | `ST,GS,+024.650kg`, `  24.650 kg`, `12 pcs` | first number + unit; ST/US = stable/unstable |
| stgs | `ST,GS,+018.450kg` | strict; `OL` = overload |
| plain-kg | `18.450` | one number per line in kg |
| plain-g | `18450` | grams |
| regex | anything | your pattern, group 1 = weight, optional `(?<stable>…)` `(?<unit>kg|g)` |

Steps: set COM port (list shows detected ports), baud / data bits / parity / stop bits **from the scale manual** (usually 9600 8-N-1) → *Save & connect*.
Watch **Last raw lines** — paste one into *TEST* and pick the protocol whose result shows the right grams. If the scale only answers when asked, enter its *request command* (e.g. `W\r`).
Stability: from the ST/US flag if the scale sends it, otherwise N equal readings in a row (default 3).
"Port already in use" = close the scale's own software. USB-serial adapters change COM number per USB socket — keep the same socket.

**Security:** every weight from the scale is signed by that counter (HMAC). The server treats any typed or altered weight as **MANUAL** (needs permission/PIN when configured). The simulator is only accepted when Settings → *Accept simulator weights* is on (testing).
No scale? Type the weight in the weight box (manual weight).

## Printer
* Install the printer's Windows driver (e.g. "POS-80"). Set paper (58mm / 80mm / A4), printer name and copies per counter in **Counters**.
* Printing is silent (no dialog) when Settings → *Print without dialog* is on. *Hardware → Test print* prints a sample.
* A printer failure never loses the bill: it is already saved; press F10 to print again when fixed.
* Thermal printers that cannot print ₹: set the printer driver font to a Unicode font or use A4.
