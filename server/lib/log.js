'use strict';
/** Minimal file + console logger. Technical details go here, never to operators. */
const fs = require('fs'), path = require('path');
let file = null;
function init(dir) { try { fs.mkdirSync(dir, { recursive: true }); file = path.join(dir, 'server.log'); rotate(); } catch (e) { file = null; } }
function rotate() { try { if (file && fs.statSync(file).size > 5e6) fs.renameSync(file, file + '.1'); } catch (e) {} }
function write(level, msg, extra) {
  const line = `${new Date().toISOString()} ${level} ${msg}${extra ? ' ' + (extra.stack || JSON.stringify(extra)) : ''}`;
  if (level === 'ERROR') console.error(line); else if (process.env.NODE_ENV !== 'test') console.log(line);
  if (file) fs.appendFile(file, line + '\n', () => {});
}
module.exports = { init, info: (m, e) => write('INFO', m, e), warn: (m, e) => write('WARN', m, e), error: (m, e) => write('ERROR', m, e) };
