// Runs before `npm run dist`: copies the cloud address from .env into shop-config.json so installed PCs need no typing.
const fs = require('fs'); const o = {};
for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#')) o[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
if (!o.MONGO_URI || /xxxxx|USER:PASSWORD/.test(o.MONGO_URI)) { console.error('\nSTOP: put your real MONGO_URI in the .env file first.\n'); process.exit(1); }
fs.writeFileSync('shop-config.json', JSON.stringify({ MONGO_URI: o.MONGO_URI, MONGO_DB: o.MONGO_DB || 'uniquebasket' }));
console.log('shop-config.json created (cloud address bundled into the installer; manager password is NOT bundled)');
