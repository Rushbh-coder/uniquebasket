# Cloud
v3 is local-first: the manager PC is the server. Options for the cloud:
* **Atlas as the database** (PC Setup → database address `mongodb+srv://…`) — only the manager PC holds it; billing needs internet.
* **Hosted server**: `node cloud.js` (or the Dockerfile) on a VPS with `MONGO_URI`, `ADMIN_PASSWORD`; counters enrol to its https address.
* **Off-site backup**: set `BACKUP_DIR` to a OneDrive/Google Drive synced folder.
Background sync of a local shop database to a cloud copy is designed but **not built yet** — see docs/STATUS.md.
