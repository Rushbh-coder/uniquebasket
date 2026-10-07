'use strict';
/* Receipt rendering tests (client/src/lib/print.js). The client is ES modules, so it is bundled to a temporary
 * CommonJS file with esbuild (already installed with vite) and loaded from there. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'printtest-')), 'print.cjs');
require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '..', 'client', 'src', 'lib', 'print.js')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent' });
const { receiptHtml, amountInWords, numberWords } = require(out);

const SHOP = { name: 'Unique Basket', tagline: 'Fresh Fruits & Vegetables', address: 'Opp. Haridwar Height, Nana Mava Main Road', city: 'Rajkot', state: 'Gujarat', phone: '80909 84646', gstin: '24ABCDE1234F1Z5', footer: 'Thank You! Visit Again' };
/** the sample bill from the print spec: 1155.20 gross, 15.20 discount, 1140.00 net, 1200 cash received */
const sample = (over = {}) => ({
  no: 'INV/2026-27/C1-000123', at: '2026-10-07T10:15:00.000Z', terminalCode: 'COUNTER-01', operatorName: 'Operator 1', by: 'operator1', status: 'COMPLETED', saleMode: 'RETAIL',
  customer: 'Ramesh <b>Patel</b>', customerPhone: '9876543210', customerAddress: 'New Road 12', remarks: 'deliver by 5pm',
  items: [
    { name: 'Tomato', localName: 'ટામેટા', unit: 'KG', qty: 18450, rate: 3200, mrp: 3500, gross: 59040, discount: 777, amount: 58263, src: 'SCALE' },
    { name: 'Potato', localName: 'બટાકા', unit: 'KG', qty: 10200, rate: 2400, gross: 24480, discount: 322, amount: 24158, src: 'SCALE' },
    { name: 'Onion', localName: 'ડુંગળી', unit: 'KG', qty: 5000, rate: 2800, gross: 14000, discount: 184, amount: 13816, src: 'MANUAL' },
    { name: 'Lemon', localName: 'લીંબુ', unit: 'PCS', qty: 12, rate: 500, gross: 6000, discount: 79, amount: 5921, src: 'COUNT' },
    { name: 'Banana', localName: 'કેળા', unit: 'DOZEN', qty: 2, rate: 6000, gross: 12000, discount: 158, amount: 11842, src: 'COUNT' },
  ],
  sub: 115520, discount: 1520, tax: 0, taxable: 114000, roundOff: 0, total: 114000,
  payments: [{ mode: 'CASH', amount: 114000 }], mode: 'CASH', tendered: 120000, change: 6000, creditAmount: 0, ...over,
});
const text = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#8377;/g, '₹').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('amount in words: Indian system, paise, large numbers', () => {
  assert.equal(amountInWords(114000), 'Rupees One Thousand One Hundred Forty Only');
  assert.equal(amountInWords(1234567890), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only');
  assert.equal(amountInWords(59040), 'Rupees Five Hundred Ninety and Forty Paise Only');
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(5), 'Rupees Zero and Five Paise Only');
  assert.equal(amountInWords(10000000), 'Rupees One Lakh Only');
  assert.equal(numberWords(100), 'One Hundred'); assert.equal(numberWords(19), 'Nineteen'); assert.equal(numberWords(1000000000), 'One Hundred Crore');
});
for (const paper of ['58mm', '80mm']) test(`thermal ${paper}: layout parts, amounts, escaping`, () => {
  const html = receiptHtml(sample(), SHOP, { paper, logo: 'data:image/png;base64,AAAA' }), t = text(html);
  assert.match(html, new RegExp(`@page\\{margin:0;size:${paper} auto\\}`));
  assert.match(html, /<img class="logo" src="data:image\/png;base64,AAAA">/);
  assert.ok(!html.includes('DUPLICATE COPY'));
  assert.match(t, /CASH MEMO/); assert.match(t, /INV\/2026-27\/C1-000123/); assert.match(t, /GSTIN: 24ABCDE1234F1Z5/);
  assert.ok(html.includes('Ramesh &lt;b&gt;Patel&lt;/b&gt;') && !html.includes('<b>Patel</b>'), 'customer name is escaped');
  assert.match(t, /1\. Tomato ટામેટા 18\.450 kg 32\.00 590\.40/);            // qty x rate, not the discounted amount
  assert.match(t, /3\. Onion ડુંગળી M 5\.000 kg 28\.00 140\.00/);
  assert.match(t, /Items: 5 \| Wt: 33\.650 kg \| Pcs: 14/);
  assert.match(t, /Gross Amount 1,155\.20 Discount - 15\.20/);
  assert.match(t, /NET TOTAL ₹ 1,140\.00 Rupees One Thousand One Hundred Forty Only/);
  assert.match(t, /Paid by CASH 1,140\.00 Cash Received 1,200\.00 Change Returned 60\.00/);
  assert.match(t, /You saved ₹ 70\.55 on this bill!/);                       // 15.20 discount + (35 - 32) x 18.450 kg
  assert.match(t, /Note: deliver by 5pm/); assert.match(t, /Thank You! Visit Again Fresh fruits & vegetables every day/);
  assert.match(t, /Goods once sold will not be taken back\./); assert.match(t, /\*\*\* INV\/2026-27\/C1-000123 \*\*\*\s*$/);
  assert.ok(!/Taxable|CGST|Round Off|credit/.test(t));
});
test('thermal: duplicate, cancelled, tax invoice, UPI reference, credit, wholesale, no logo', () => {
  const b = sample({ status: 'CANCELLED', saleMode: 'WHOLESALE', tax: 5429, taxable: 108571, roundOff: 40, total: 114040, tendered: null, change: 0, creditAmount: 50000,
    payments: [{ mode: 'UPI', amount: 64040, ref: '4521' }, { mode: 'CREDIT', amount: 50000 }] });
  const t = text(receiptHtml(b, SHOP, { duplicate: true, logo: '' }));
  assert.match(t, /^\s*\*\* DUPLICATE COPY \*\*/); assert.match(t, /CANCELLED BILL/); assert.match(t, /Sale: WHOLESALE/);
  assert.match(t, /Taxable Value 1,085\.71 CGST 27\.14 SGST 27\.15 Round Off \+0\.40/);   // CGST = floor(tax / 2), SGST = the rest
  assert.match(t, /Paid by UPI \(UTR 4521\) 640\.40 Paid by CREDIT 500\.00 Balance on credit 500\.00/);
  assert.ok(!/Cash Received|<img/.test(receiptHtml(b, SHOP, { logo: '' })));
  assert.match(text(receiptHtml(sample({ tax: 5429, taxable: 108571 }), SHOP, {})), /TAX INVOICE/);
  assert.ok(!/CGST/.test(text(receiptHtml(sample({ tax: 5429, taxable: 108571 }), SHOP, { showGst: false }))));
  assert.ok(!/You saved/.test(text(receiptHtml(sample({ discount: 0, items: sample().items.map((i) => ({ ...i, mrp: 0 })) }), SHOP, {}))));
});
test('A4: invoice parts, HSN tax table, signature', () => {
  const items = sample().items.map((i, k) => ({ ...i, hsn: k < 3 ? '0702' : '0805', taxRate: 500, taxable: Math.round(i.amount / 1.05), taxAmount: i.amount - Math.round(i.amount / 1.05) }));
  const tax = items.reduce((s, i) => s + i.taxAmount, 0);
  const html = receiptHtml(sample({ items, tax, taxable: 114000 - tax }), SHOP, { paper: 'A4', duplicate: true, logo: 'data:image/png;base64,AAAA' }), t = text(html);
  assert.match(html, /@page\{size:A4;margin:12mm\}/); assert.match(t, /DUPLICATE COPY/); assert.match(t, /TAX INVOICE/); assert.match(t, /BILL TO/);
  assert.match(t, /Invoice No INV\/2026-27\/C1-000123/); assert.match(t, /Onion ડુંગળી Manual wt 0702 5\.000 kg 28\.00 1\.84 5% 138\.16/);
  assert.match(t, /Amount in words: Rupees One Thousand One Hundred Forty Only/);
  assert.match(t, /HSN GST % Taxable CGST SGST Total Tax 0702 5%/); assert.match(t, /NET TOTAL ₹ 1,140\.00/);
  assert.match(t, /Terms & Conditions 1\. Goods once sold/); assert.match(t, /For Unique Basket Authorised Signatory/);
  assert.ok(!/HSN GST %/.test(text(receiptHtml(sample(), SHOP, { paper: 'A4' }))), 'no tax table on a bill without tax');
});
test('old bills without the newer fields still print', () => {
  const legacy = { no: 'C1-000007', at: '2026-09-30T08:00:00.000Z', counter: 'C1', by: 'operator', items: [{ name: 'Tomato', unit: 'KG', qty: 1000, rate: 3000, amount: 3000 }], sub: 3000, total: 3000, mode: 'CASH' };
  for (const paper of ['58mm', '80mm', 'A4']) { const t = text(receiptHtml(legacy, {}, { paper })); assert.match(t, /Tomato/); assert.match(t, /30\.00/); assert.match(t, /Paid by CASH 30\.00/); }
});
