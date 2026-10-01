// Cloud API entry point. Reads .env if present (local testing); on Render use dashboard environment variables.
// Forgot / wrong manager password?  run:  node cloud.js --reset-admin   (sets manager password = ADMIN_PASSWORD)
const fs = require('fs');
try {
  for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) {}
process.env.APP_MODE = 'server';
const srv = require('./server/index');
(async () => {
  const p = await srv.start(+process.env.PORT || 4310, '0.0.0.0');
  console.log('Cloud API listening on', p);
  if (process.argv.includes('--reset-admin') || process.env.RESET_ADMIN === '1') {
    await srv.resetAdmin(process.env.ADMIN_PASSWORD);
    console.log('Manager password has been set to your ADMIN_PASSWORD. Login: manager / <ADMIN_PASSWORD>');
    process.exit(0);
  }
})().catch(e => { console.error('START FAILED:', e.message); process.exit(1); });
