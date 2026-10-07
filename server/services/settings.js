'use strict';
/** Shop-wide settings stored in the `settings` collection (doc _id "config"). Cached; changes broadcast to all PCs. */
const { db } = require('../db');
const DEFAULTS = {
  shop: { name: 'Unique Basket', tagline: 'Fresh Fruits & Vegetables', address: '', city: 'Rajkot', phone: '', gstin: '', state: 'Gujarat', footer: 'Thank you! Visit again' },
  billing: {
    invoicePrefix: 'INV',           // INV/2026-27/C1-000001
    numbering: 'COUNTER',           // COUNTER = series per counter (legacy-compatible), GLOBAL = one shop-wide series
    roundStep: 100,                 // paise: 100 = round grand total to nearest rupee, 1 = no rounding
    priceIncludesTax: true,         // rates already include GST (typical retail)
    allowNegativeStock: true,       // fresh produce: stock is often entered after sale; set false to block
    operatorApprovals: false,       // false = operators never see a manager PIN prompt while billing (manual weight, rate, discount, credit limit); everything stays in the audit log
    manualWeightNeedsApproval: true,// with operatorApprovals on: operator manual weight needs manager PIN
    creditPolicy: 'BLOCK',          // BLOCK | WARN when credit limit exceeded
    operatorCanReprint: true,
    reprintReasonRequired: false,
    holdCrossTerminal: false,       // operators may resume bills held on another counter
    allowMockScale: false,          // simulator readings count as SCALE (development only)
    whatsappOnSave: false,
    paymentModes: ['CASH', 'UPI'],  // modes offered on the Sale Entry screen and accepted by the server (Settings can add CARD, BANK, CREDIT)
  },
  // max discount as basis points of bill subtotal (200 = 2%)
  discountLimits: { OPERATOR: 200, MANAGER: 1000, ACCOUNTANT: 0, STOCK_MANAGER: 0, PURCHASE_MANAGER: 0, OWNER: 10000, SUPER_ADMIN: 10000 },
  print: { paper: '80mm', copies: 1, silent: true, showGstBreakup: true, saveCopy: 'OFF' }, // saveCopy: OFF | PRINT_AND_SAVE | SAVE_ONLY (PDF of each bill on the billing PC)
  shortcuts: {},                    // overrides of the default key map, e.g. { "payment": "F8" }
  backup: { dailyAt: '23:30', keepDays: 30 },
};
let cache = null;
const merge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k]; return o; };
async function get() {
  if (cache) return cache;
  const d = await db.c.settings.findOne({ _id: 'config' });
  cache = merge(DEFAULTS, d ? d.v : {});
  return cache;
}
async function save(patch) {
  const cur = await get();
  const next = merge(cur, patch);
  await db.c.settings.update({ _id: 'config' }, { _id: 'config', v: next }, { upsert: true });
  cache = next; return next;
}
const reset = () => { cache = null; };
/** public subset any logged-in screen may read (no secrets exist in config, but keep it explicit) */
const publicView = (c) => ({ shop: c.shop, billing: c.billing, discountLimits: c.discountLimits, print: c.print, shortcuts: c.shortcuts });
module.exports = { get, save, reset, DEFAULTS, publicView };
