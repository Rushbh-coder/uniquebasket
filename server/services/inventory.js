'use strict';
/** Stock ledger. Every stock change is a row in `inventory` + an atomic $inc on products.stock,
 *  always inside the caller's transaction. Quantities are in stored units (grams for KG, count for PCS). */
const { businessDate } = require('../lib/dates');
const { BadRequest } = require('../lib/errors');
const settings = require('./settings');
const TYPES = ['OPENING', 'SALE', 'SALE_RETURN', 'SALE_CANCEL', 'PURCHASE', 'PURCHASE_RETURN', 'PURCHASE_CANCEL', 'ADJUST', 'WASTAGE'];
/** qty > 0 = inward, qty < 0 = outward */
async function move(t, { productId, qty, type, ref = '', refId = '', by = '', reason = '', terminal = '' }) {
  if (!TYPES.includes(type)) throw new Error('bad stock type ' + type);
  if (!Number.isSafeInteger(qty) || qty === 0) return null;
  const p = await t.products.findOne({ _id: productId });
  if (!p) throw new BadRequest('Product not found');
  const after = (p.stock || 0) + qty;
  if (qty < 0 && after < 0 && !(await settings.get()).billing.allowNegativeStock && type !== 'ADJUST')
    throw new BadRequest(`Insufficient stock for ${p.name}`);
  await t.products.update({ _id: productId }, { $inc: { stock: qty } });
  const at = new Date().toISOString();
  return t.inventory.insert({ productId, productName: p.name, unit: p.unit, at, date: businessDate(), type, in: qty > 0 ? qty : 0, out: qty < 0 ? -qty : 0, balance: after, ref, refId, by, reason, terminal });
}
module.exports = { move, TYPES };
