/** Receipt / invoice rendering (58mm, 80mm thermal + A4 tax invoice) + printing.
 *  Electron: silent print to the counter's configured printer via the preload bridge (no browser dialog).
 *  Browser: hidden iframe + print dialog. A failed print never affects the saved bill.
 *  The shop logo (client/public/logo.png) is embedded as a data URL, because the print window cannot load files. */
import { rs, qtyStr, unitLabel, lineAmount } from './fmt';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- logo: loaded once, cached as data URL ---------- */
let LOGO = '';
export function preloadLogo(url = './logo.png') {
  if (typeof fetch !== 'function' || typeof FileReader === 'undefined') return Promise.resolve('');
  return fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }) : ''))
    .then((d) => { LOGO = d || ''; return LOGO; }).catch(() => '');
}
if (typeof window !== 'undefined') preloadLogo();
export const setLogo = (d) => { LOGO = d || ''; };

/* ---------- amount in words (Indian system: thousand, lakh, crore) ---------- */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
const three = (n) => (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '') : two(n));
export function numberWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thou = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push((crore > 999 ? numberWords(crore) : three(crore)) + ' Crore');
  if (lakh) parts.push(two(lakh) + ' Lakh');
  if (thou) parts.push(two(thou) + ' Thousand');
  if (n) parts.push(three(n));
  return parts.join(' ');
}
/** 59040 paise -> "Rupees Five Hundred Ninety and Forty Paise Only" */
export function amountInWords(paise) {
  const neg = paise < 0; paise = Math.abs(Math.round(paise || 0));
  const r = Math.floor(paise / 100), p = paise % 100;
  return (neg ? 'Minus ' : '') + 'Rupees ' + numberWords(r) + (p ? ' and ' + two(p) + ' Paise' : '') + ' Only';
}

const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }); };
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); };
const DEFAULT_TERMS = ['Goods once sold will not be taken back.', 'Please check weight & items before leaving the counter.', 'Fresh produce: no return after 24 hours.'];

export function receiptHtml(b, shop = {}, { paper = '80mm', duplicate = false, showGst = true, logo = LOGO, terms = DEFAULT_TERMS } = {}) {
  return paper === 'A4' ? a4Html(b, shop, { duplicate, showGst, logo, terms }) : thermalHtml(b, shop, { paper, duplicate, showGst, logo, terms });
}

function common(b) {
  const cg = Math.floor((b.tax || 0) / 2), sg = (b.tax || 0) - cg;
  const pays = (b.payments && b.payments.length ? b.payments : [{ mode: b.mode || 'CASH', amount: b.total }]);
  const mrpSaving = (b.items || []).reduce((s, i) => s + (i.mrp && i.mrp > i.rate ? lineAmount(i.unit, i.qty, i.mrp - i.rate) : 0), 0); // integer paise, same rounding as a bill line
  const saved = (b.discount || 0) + mrpSaving;
  const kg = (b.items || []).filter((i) => i.unit === 'KG').reduce((s, i) => s + i.qty, 0);
  const pcs = (b.items || []).filter((i) => i.unit !== 'KG' && i.unit !== 'LITRE').reduce((s, i) => s + i.qty, 0);
  const title = b.status === 'CANCELLED' ? 'CANCELLED BILL' : b.tax ? 'TAX INVOICE' : 'CASH MEMO';
  return { cg, sg, pays, saved, kg, pcs, title };
}

/* ================= 58mm / 80mm thermal ================= */
function thermalHtml(b, shop, { paper, duplicate, showGst, logo, terms }) {
  const W = paper === '58mm' ? 48 : 72;               // printable width in mm
  const fs = paper === '58mm' ? 10.5 : 12;
  const c = common(b);
  const rows = b.items.map((i, k) => `
    <tr class="it"><td colspan="4"><b>${k + 1}. ${esc(i.name)}</b>${i.localName ? ` <span class="lc">${esc(i.localName)}</span>` : ''}${i.src === 'MANUAL' ? ' <span class="tag">M</span>' : ''}</td></tr>
    <tr class="iq"><td></td><td class="r">${qtyStr(i.unit, i.qty)} ${unitLabel(i.unit)}</td><td class="r">${rs(i.rate)}</td><td class="r b">${rs(i.gross != null ? i.gross : i.amount)}</td></tr>`).join(''); // qty x rate; the bill discount is shown once, below
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page{margin:0;size:${paper === '58mm' ? '58mm' : '80mm'} auto}
  *{box-sizing:border-box}body{margin:0;padding:2mm ${paper === '58mm' ? '2mm' : '3mm'};width:${W + (paper === '58mm' ? 4 : 6)}mm;font:${fs}px/1.3 Arial,Helvetica,sans-serif;color:#000;background:#fff}
  .c{text-align:center}.r{text-align:right}.b{font-weight:700}table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}
  .logo{display:block;margin:0 auto 2px;max-width:${paper === '58mm' ? 34 : 46}mm;max-height:22mm;filter:grayscale(1) brightness(1.25) contrast(2.4)}
  .shop{font-size:${fs + 6}px;font-weight:800;letter-spacing:.5px;text-transform:uppercase}.tl{font-size:${fs - 1}px;font-style:italic}
  .sm{font-size:${fs - 1.5}px}.hr{border-top:1px dashed #000;margin:4px 0}.hr2{border-top:2px solid #000;margin:4px 0}
  .ttl{margin:3px 0;padding:2px 0;border-top:2px solid #000;border-bottom:2px solid #000;font-weight:800;letter-spacing:2px;text-align:center}
  .meta td{font-size:${fs - 1}px}.meta58{font-size:${fs - 1}px;word-break:break-all}.th td{font-weight:700;border-bottom:1px solid #000;font-size:${fs - 1}px}
  .it td{padding-top:3px}.lc{font-weight:400;font-size:${fs - 1.5}px}.tag{border:1px solid #000;font-size:${fs - 3}px;padding:0 2px}
  .tot td{padding:1px 0}.grand{font-size:${fs + (paper === '58mm' ? 3 : 5)}px;font-weight:800;border-top:2px solid #000;border-bottom:2px solid #000}
  .grand td{padding:3px 0;white-space:nowrap}.words{font-size:${fs - 1}px;font-style:italic;margin:3px 0}
  .box{border:1px solid #000;padding:3px;margin:4px 0;text-align:center;font-weight:700}
  .dup{border:2px solid #000;text-align:center;font-weight:800;margin:0 0 4px;padding:2px;letter-spacing:1px}
  .ty{font-size:${fs + 3}px;font-weight:800;margin-top:4px}.terms{font-size:${fs - 2.5}px;text-align:left;margin-top:3px}
  </style></head><body>
  ${duplicate ? '<div class="dup">** DUPLICATE COPY **</div>' : ''}
  <div class="c">
    ${logo ? `<img class="logo" src="${logo}">` : ''}
    <div class="shop">${esc(shop.name || '')}</div>
    ${shop.tagline ? `<div class="tl">${esc(shop.tagline)}</div>` : ''}
    <div class="sm">${esc([shop.address, shop.city, shop.state].filter(Boolean).join(', '))}</div>
    ${shop.phone ? `<div class="sm">Ph: ${esc(shop.phone)}</div>` : ''}
    ${shop.gstin ? `<div class="sm b">GSTIN: ${esc(shop.gstin)}</div>` : ''}
  </div>
  <div class="ttl">${c.title}</div>
  ${paper === '58mm' ? `<div class="meta58">
    <div>Bill: <b>${esc(b.no)}</b></div><div>${fmtDate(b.at)} &nbsp;${fmtTime(b.at)}</div>
    <div>${esc(b.terminalCode || b.counter || '')} / ${esc(b.operatorName || b.by || '')}</div>${b.saleMode === 'WHOLESALE' ? '<div><b>Sale: WHOLESALE</b></div>' : ''}</div>`
  : `<table class="meta">
    <tr><td>Bill No:</td><td class="r b">${esc(b.no)}</td></tr>
    <tr><td>Date: ${fmtDate(b.at)}</td><td class="r">Time: ${fmtTime(b.at)}</td></tr>
    <tr><td>Counter: ${esc(b.terminalCode || b.counter || '')}</td><td class="r">Cashier: ${esc(b.operatorName || b.by || '')}</td></tr>
    ${b.saleMode === 'WHOLESALE' ? '<tr><td colspan="2"><b>Sale: WHOLESALE</b></td></tr>' : ''}
  </table>`}
  ${b.customer || b.customerPhone ? `<div class="hr"></div><div class="sm"><b>Customer:</b> ${esc(b.customer || '')}${b.customerPhone ? '<br>Ph: ' + esc(b.customerPhone) : ''}${b.customerAddress ? '<br>' + esc(b.customerAddress) : ''}${b.customerGstin ? '<br>GSTIN: ' + esc(b.customerGstin) : ''}</div>` : ''}
  <div class="hr"></div>
  <table>
    <tr class="th"><td style="width:6%"></td><td class="r" style="width:34%">Qty</td><td class="r" style="width:26%">Rate</td><td class="r" style="width:34%">Amount</td></tr>
    ${rows}
  </table>
  <div class="hr"></div>
  <table class="tot">
    <tr><td colspan="2">Items: ${b.items.length}${c.kg ? ` | Wt: ${(c.kg / 1000).toFixed(3)} kg` : ''}${c.pcs ? ` | Pcs: ${c.pcs}` : ''}</td></tr>
    <tr><td>Gross Amount</td><td class="r">${rs(b.sub)}</td></tr>
    ${b.discount ? `<tr><td>Discount</td><td class="r">- ${rs(b.discount)}</td></tr>` : ''}
    ${b.tax && showGst ? `<tr><td>Taxable Value</td><td class="r">${rs(b.taxable)}</td></tr><tr><td>CGST</td><td class="r">${rs(c.cg)}</td></tr><tr><td>SGST</td><td class="r">${rs(c.sg)}</td></tr>` : ''}
    ${b.roundOff ? `<tr><td>Round Off</td><td class="r">${b.roundOff > 0 ? '+' : ''}${rs(b.roundOff)}</td></tr>` : ''}
  </table>
  <table class="grand"><tr><td>NET TOTAL</td><td class="r">&#8377; ${rs(b.total)}</td></tr></table>
  <div class="words">${amountInWords(b.total)}</div>
  <table class="tot">
    ${c.pays.map((p) => `<tr><td>Paid by ${esc(p.mode)}${p.ref ? ' (' + (p.mode === 'UPI' || p.mode === 'BANK' ? 'UTR ' : '') + esc(p.ref) + ')' : ''}</td><td class="r">${rs(p.amount)}</td></tr>`).join('')}
    ${b.tendered != null ? `<tr><td>Cash Received</td><td class="r">${rs(b.tendered)}</td></tr><tr><td class="b">Change Returned</td><td class="r b">${rs(b.change || 0)}</td></tr>` : ''}
    ${b.creditAmount ? `<tr><td class="b">Balance on credit</td><td class="r b">${rs(b.creditAmount)}</td></tr>` : ''}
  </table>
  ${c.saved > 0 ? `<div class="box">You saved &#8377; ${rs(c.saved)} on this bill!</div>` : ''}
  ${b.remarks ? `<div class="sm">Note: ${esc(b.remarks)}</div>` : ''}
  ${b.status === 'CANCELLED' ? '<div class="dup">CANCELLED</div>' : ''}
  <div class="hr2"></div>
  <div class="c">
    <div class="ty">${esc(shop.footer || 'Thank You! Visit Again')}</div>
    <div class="sm">Fresh fruits &amp; vegetables every day</div>
  </div>
  ${terms && terms.length ? `<div class="terms">${terms.map((t) => '&bull; ' + esc(t)).join('<br>')}</div>` : ''}
  <div class="c sm" style="margin-top:4px">*** ${esc(b.no)} ***</div>
  </body></html>`;
}

/* ================= A4 tax invoice ================= */
function a4Html(b, shop, { duplicate, showGst, logo, terms }) {
  const c = common(b);
  const hsn = {};
  b.items.forEach((i) => { const k = (i.hsn || '-') + '|' + (i.taxRate || 0); const x = hsn[k] || (hsn[k] = { hsn: i.hsn || '-', rate: (i.taxRate || 0) / 100, taxable: 0, tax: 0 }); x.taxable += i.taxable != null ? i.taxable : i.amount; x.tax += i.taxAmount || 0; });
  const rows = b.items.map((i, k) => `<tr><td class="c">${k + 1}</td><td><b>${esc(i.name)}</b>${i.localName ? ` <span class="mut">${esc(i.localName)}</span>` : ''}${i.src === 'MANUAL' ? ' <span class="tag">Manual wt</span>' : ''}</td><td class="c">${esc(i.hsn || '')}</td>
    <td class="r">${qtyStr(i.unit, i.qty)} ${unitLabel(i.unit)}</td><td class="r">${rs(i.rate)}</td><td class="r">${i.discount ? rs(i.discount) : '-'}</td><td class="r">${i.taxRate ? i.taxRate / 100 + '%' : '-'}</td><td class="r b">${rs(i.amount)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page{size:A4;margin:12mm}*{box-sizing:border-box}body{margin:0;font:12px/1.4 Arial,Helvetica,sans-serif;color:#111;width:186mm}
  .c{text-align:center}.r{text-align:right}.b{font-weight:700}.mut{color:#555;font-weight:400}table{width:100%;border-collapse:collapse}
  .head{display:flex;align-items:center;gap:14px;border-bottom:3px solid #1f6b3a;padding-bottom:8px}.head img{height:70px}
  .shop{font-size:24px;font-weight:800;color:#1f6b3a;text-transform:uppercase;letter-spacing:.5px}.tl{font-style:italic;color:#333}
  .ttl{margin:8px 0;text-align:center;font-size:16px;font-weight:800;letter-spacing:3px;background:#1f6b3a;color:#fff;padding:4px}
  .info td{border:1px solid #bbb;padding:5px 7px;vertical-align:top;width:50%}.lbl{color:#555;font-size:11px}
  .items th{background:#e8f2ea;border:1px solid #9bb8a4;padding:5px;font-size:11px;text-transform:uppercase}.items td{border:1px solid #ccc;padding:5px}
  .items tbody tr:nth-child(even){background:#fafafa}.tag{font-size:10px;border:1px solid #999;padding:0 3px;border-radius:2px}
  .sum{display:flex;gap:12px;margin-top:8px}.sum>div{flex:1}.tot td{padding:4px 7px;border-bottom:1px solid #ddd}
  .grand td{font-size:17px;font-weight:800;background:#1f6b3a;color:#fff;padding:7px}
  .words{border:1px dashed #1f6b3a;padding:6px 8px;margin-top:8px;background:#f4faf5}
  .hsn th,.hsn td{border:1px solid #ccc;padding:3px 5px;font-size:11px}.hsn th{background:#f0f0f0}
  .foot{display:flex;justify-content:space-between;margin-top:14px;align-items:flex-end}.sign{text-align:center;width:60mm}.sign div{border-top:1px solid #000;margin-top:40px;padding-top:3px}
  .ty{text-align:center;margin-top:14px;font-size:15px;font-weight:800;color:#1f6b3a}.dup{border:2px solid #b42318;color:#b42318;font-weight:800;text-align:center;padding:3px;margin-bottom:6px;letter-spacing:2px}
  .terms{font-size:11px;color:#333}.save{display:inline-block;margin-top:6px;border:1px solid #1f6b3a;color:#1f6b3a;padding:3px 8px;font-weight:700}
  </style></head><body>
  ${duplicate ? '<div class="dup">DUPLICATE COPY</div>' : ''}
  <div class="head">${logo ? `<img src="${logo}">` : ''}<div style="flex:1"><div class="shop">${esc(shop.name || '')}</div>${shop.tagline ? `<div class="tl">${esc(shop.tagline)}</div>` : ''}
    <div>${esc([shop.address, shop.city, shop.state].filter(Boolean).join(', '))}</div><div>${shop.phone ? 'Phone: ' + esc(shop.phone) : ''}${shop.gstin ? ' &nbsp;|&nbsp; <b>GSTIN: ' + esc(shop.gstin) + '</b>' : ''}</div></div></div>
  <div class="ttl">${c.title}</div>
  <table class="info"><tr>
    <td><div class="lbl">BILL TO</div><b>${esc(b.customer || 'Walk-in Customer')}</b>${b.customerPhone ? '<br>Ph: ' + esc(b.customerPhone) : ''}${b.customerAddress ? '<br>' + esc(b.customerAddress) : ''}${b.customerGstin ? '<br>GSTIN: ' + esc(b.customerGstin) : ''}</td>
    <td><table><tr><td style="border:0;padding:1px" class="lbl">Invoice No</td><td style="border:0;padding:1px" class="b">${esc(b.no)}</td></tr><tr><td style="border:0;padding:1px" class="lbl">Date / Time</td><td style="border:0;padding:1px">${fmtDate(b.at)} ${fmtTime(b.at)}</td></tr>
    <tr><td style="border:0;padding:1px" class="lbl">Counter / Cashier</td><td style="border:0;padding:1px">${esc(b.terminalCode || b.counter || '')} / ${esc(b.operatorName || b.by || '')}</td></tr>${b.saleMode === 'WHOLESALE' ? '<tr><td style="border:0;padding:1px" class="lbl">Sale type</td><td style="border:0;padding:1px" class="b">WHOLESALE</td></tr>' : ''}</table></td></tr></table>
  <table class="items" style="margin-top:8px"><thead><tr><th style="width:5%">#</th><th>Item</th><th style="width:9%">HSN</th><th style="width:13%">Qty</th><th style="width:10%">Rate</th><th style="width:9%">Disc</th><th style="width:7%">GST</th><th style="width:13%">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="sum"><div>
      <div class="words"><b>Amount in words:</b><br>${amountInWords(b.total)}</div>
      ${b.tax && showGst ? `<table class="hsn" style="margin-top:8px"><tr><th>HSN</th><th>GST %</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>Total Tax</th></tr>${Object.values(hsn).map((h) => `<tr><td>${esc(h.hsn)}</td><td class="r">${h.rate}%</td><td class="r">${rs(h.taxable)}</td><td class="r">${rs(Math.floor(h.tax / 2))}</td><td class="r">${rs(h.tax - Math.floor(h.tax / 2))}</td><td class="r">${rs(h.tax)}</td></tr>`).join('')}</table>` : ''}
      ${c.saved > 0 ? `<div class="save">You saved &#8377; ${rs(c.saved)} on this invoice</div>` : ''}
      ${b.remarks ? `<div style="margin-top:6px"><b>Note:</b> ${esc(b.remarks)}</div>` : ''}
    </div><div style="flex:0 0 72mm"><table class="tot">
      <tr><td>Items / Qty</td><td class="r">${b.items.length}${c.kg ? ` / ${(c.kg / 1000).toFixed(3)} kg` : ''}${c.pcs ? ` / ${c.pcs} pcs` : ''}</td></tr>
      <tr><td>Gross Amount</td><td class="r">${rs(b.sub)}</td></tr>
      ${b.discount ? `<tr><td>Discount</td><td class="r">- ${rs(b.discount)}</td></tr>` : ''}
      ${b.tax && showGst ? `<tr><td>Taxable Value</td><td class="r">${rs(b.taxable)}</td></tr><tr><td>CGST</td><td class="r">${rs(c.cg)}</td></tr><tr><td>SGST</td><td class="r">${rs(c.sg)}</td></tr>` : ''}
      ${b.roundOff ? `<tr><td>Round Off</td><td class="r">${b.roundOff > 0 ? '+' : ''}${rs(b.roundOff)}</td></tr>` : ''}
      <tr class="grand"><td>NET TOTAL</td><td class="r">&#8377; ${rs(b.total)}</td></tr>
      ${c.pays.map((p) => `<tr><td>Paid by ${esc(p.mode)}${p.ref ? ' (' + esc(p.ref) + ')' : ''}</td><td class="r">${rs(p.amount)}</td></tr>`).join('')}
      ${b.tendered != null ? `<tr><td>Cash Received</td><td class="r">${rs(b.tendered)}</td></tr><tr><td><b>Change Returned</b></td><td class="r b">${rs(b.change || 0)}</td></tr>` : ''}
      ${b.creditAmount ? `<tr><td><b>Balance (credit)</b></td><td class="r b">${rs(b.creditAmount)}</td></tr>` : ''}
    </table></div></div>
  ${b.status === 'CANCELLED' ? '<div class="dup" style="margin-top:8px">CANCELLED</div>' : ''}
  <div class="foot"><div class="terms"><b>Terms &amp; Conditions</b><br>${(terms || []).map((t, i) => `${i + 1}. ${esc(t)}`).join('<br>')}</div>
    <div class="sign">For <b>${esc(shop.name || '')}</b><div>Authorised Signatory</div></div></div>
  <div class="ty">${esc(shop.footer || 'Thank You! Visit Again')}</div>
  </body></html>`;
}

/** height of a thermal bill in mm, so the saved PDF is one page exactly as long as the bill */
function measureMm(html) {
  try {
    const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-same-origin'); f.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;height:10px;border:0;visibility:hidden';
    document.body.appendChild(f); f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
    const px = f.contentDocument.documentElement.scrollHeight; f.remove();
    return Math.ceil((px * 25.4) / 96);
  } catch (e) { return 0; }
}
/** save: 'OFF' | 'PRINT_AND_SAVE' | 'SAVE_ONLY' — a PDF copy on this PC (desktop app only). Returns { saved: file path or '' }. */
export async function printHtml(html, { printer = '', copies = 1, silent = true, paper = '80mm', save = 'OFF', fileName = '' } = {}) {
  if (window.pos && window.pos.print) {
    const wantSave = save === 'PRINT_AND_SAVE' || save === 'SAVE_ONLY';
    const r = await window.pos.print({ html, deviceName: printer, copies, silent, paper, save: wantSave ? save : 'OFF', fileName, heightMm: wantSave && paper !== 'A4' ? measureMm(html) : 0 });
    if (!r || !r.ok) throw new Error(save === 'SAVE_ONLY' ? ((r && r.error) || 'Could not save the bill file') + '. Bill is saved.' : 'Printer not available' + (r && r.error ? ': ' + r.error : '') + '. Bill is saved.' + (r && r.saved ? ' PDF copy: ' + r.saved : ''));
    if (wantSave && !r.saved) throw new Error('Printed, but the PDF copy was not saved' + (r.saveError ? ': ' + r.saveError : '') + '.');
    return { saved: r.saved || '' };
  }
  const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'; document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
  await new Promise((r) => setTimeout(r, 250)); f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 2000);
  return { saved: '' };
}
/** opens the folder with the saved bill PDFs (desktop app only) */
export const openBillsFolder = () => (window.pos && window.pos.openBills ? window.pos.openBills() : Promise.resolve({ ok: false, error: 'Only in the desktop app' }));
