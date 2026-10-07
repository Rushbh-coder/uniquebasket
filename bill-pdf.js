// Saves a printed bill as a PDF file on this PC (Documents\Unique Basket Bills\<year-month>\<bill no>.pdf).
// Used by the Electron main process next to normal printing; never needed for the bill itself to be saved.
const fs = require('fs'), path = require('path');
const MM = 1 / 25.4; // millimetres -> inches (printToPDF sizes are in inches)
const FOLDER = 'Unique Basket Bills';

const billsDir = (documents) => path.join(documents, FOLDER);
/** "INV/2026-27/C1-000123" -> "INV-2026-27-C1-000123" : a safe file name, never a path */
const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'bill-' + Date.now();

/**
 * @param webContents  window that already shows the bill
 * @param o  { documents, fileName, paper: '58mm'|'80mm'|'A4', heightMm (thermal: height of the bill, measured by the screen) }
 * @returns full path of the saved file
 */
async function savePdf(webContents, o) {
  const now = new Date();
  const dir = path.join(billsDir(o.documents), `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeName(o.fileName) + '.pdf');
  const opts = { printBackground: true };
  if (o.paper === 'A4') { opts.pageSize = 'A4'; opts.preferCSSPageSize = true; } // margins come from the bill's own @page rule
  else {
    // one long page exactly as tall as the bill, like the paper roll
    const h = Math.min(Math.max(+o.heightMm || 0, 60), 3000) + 6;
    opts.pageSize = { width: (o.paper === '58mm' ? 58 : 80) * MM, height: h * MM };
    opts.margins = { top: 0, bottom: 0, left: 0, right: 0 };
  }
  const pdf = await webContents.printToPDF(opts);
  fs.writeFileSync(file + '.part', pdf); fs.renameSync(file + '.part', file); // never leave a half-written file
  return file;
}
module.exports = { savePdf, billsDir, safeName, FOLDER };
