# Keyboard shortcuts (billing screen)
Defined in ONE place: `client/src/lib/shortcuts.js`. Manager can change keys in **Settings → Keyboard shortcuts** (applies to all counters).
The v2 keys **F4 / F5 / F6 and C, A, S, M, N, P are kept exactly**. Single letters work only when the cursor is not in a text box.

| Key | Action |
|---|---|
| F1 / Ctrl+N | New bill (asks before discarding) |
| F2 / Ctrl+F / P | Product search (cursor to product box) |
| F3 | Customer: search / walk-in / new |
| F4 / C | Capture stable scale weight (adds line) |
| F5 / A | Add item |
| F6 / F9 / Ctrl+S / S | Save bill as CASH (exact amount) + print |
| F7 | Discount (₹ or %) |
| F8 | Payment window (cash/UPI/card/bank/credit/mixed) |
| F10 / Ctrl+P | Print last bill again (marked DUPLICATE, logged) |
| F11 | Hold bill (with items) / list held bills (empty bill) |
| F12 | Complete bill (opens payment) |
| M / Alt+W | Manual weight |
| Alt+R | Edit rate (only if allowed) |
| Alt+Q | Change quantity of selected counted line |
| N | Next product |
| Ctrl+H | Bill history / reprint |
| Ctrl+R | Refresh products & settings |
| ↑ / ↓ | Move in search results, or select bill line |
| Delete | Remove selected line (with confirmation) |
| Enter | Select / confirm / next field |
| Esc | Close window / clear search / back to product |

**Fast flow:** type `tom` → Enter → (weigh) → Enter → next product … → F8 → type cash received → Enter (saves & prints).
For counted items: `lem` → Enter → type quantity → Enter. Barcode scanners work in the product box (exact code/barcode first).
In the payment window: Alt+1…Alt+6 choose the mode, Enter saves.
