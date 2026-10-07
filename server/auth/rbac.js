'use strict';
/** Role → permission matrix. The server checks these on every request; the UI only uses them to hide buttons. */
const P = {
  BILL_CREATE: 'bill.create', BILL_VIEW_OWN: 'bill.view_own', BILL_VIEW_ALL: 'bill.view_all', BILL_HOLD: 'bill.hold',
  BILL_RESUME_ANY: 'bill.resume_any', BILL_REPRINT: 'bill.reprint', BILL_CANCEL: 'bill.cancel', BILL_RETURN: 'bill.return',
  RATE_OVERRIDE: 'rate.override', WEIGHT_MANUAL: 'weight.manual', DISCOUNT: 'discount', CREDIT_SALE: 'credit.sale',
  PRODUCT_VIEW: 'product.view', PRODUCT_EDIT: 'product.edit', PRICE_EDIT: 'price.edit',
  CUSTOMER_VIEW: 'customer.view', CUSTOMER_CREATE: 'customer.create', CUSTOMER_EDIT: 'customer.edit', CUSTOMER_PAYMENT: 'customer.payment',
  SUPPLIER_EDIT: 'supplier.edit', PURCHASE_EDIT: 'purchase.edit', STOCK_VIEW: 'stock.view', STOCK_ADJUST: 'stock.adjust', WASTAGE: 'stock.wastage',
  DASHBOARD: 'dashboard.view', REPORT_SALES: 'report.sales', REPORT_PROFIT: 'report.profit', AUDIT_VIEW: 'audit.view',
  USER_MANAGE: 'user.manage', TERMINAL_MANAGE: 'terminal.manage', SETTINGS: 'settings.manage', BACKUP: 'backup.manage',
  CASH_SESSION: 'cash.session', CASH_REVIEW: 'cash.review',
};
const ALL = Object.values(P);
const OPERATOR = [P.BILL_CREATE, P.BILL_VIEW_OWN, P.BILL_HOLD, P.BILL_REPRINT, P.DISCOUNT, P.CREDIT_SALE, P.PRODUCT_VIEW,
  P.CUSTOMER_VIEW, P.CUSTOMER_CREATE, P.CASH_SESSION];
// Manager: everything except confidential profit/margin reports (owner only)
const MANAGER = ALL.filter((p) => p !== P.REPORT_PROFIT);
const ROLES = {
  SUPER_ADMIN: ALL,
  OWNER: ALL,
  MANAGER,
  OPERATOR,
  ACCOUNTANT: [P.BILL_VIEW_ALL, P.CUSTOMER_VIEW, P.CUSTOMER_PAYMENT, P.PRODUCT_VIEW, P.STOCK_VIEW, P.DASHBOARD, P.REPORT_SALES, P.REPORT_PROFIT, P.CASH_REVIEW, P.AUDIT_VIEW],
  STOCK_MANAGER: [P.PRODUCT_VIEW, P.STOCK_VIEW, P.STOCK_ADJUST, P.WASTAGE, P.PURCHASE_EDIT, P.SUPPLIER_EDIT, P.DASHBOARD],
  PURCHASE_MANAGER: [P.PRODUCT_VIEW, P.STOCK_VIEW, P.PURCHASE_EDIT, P.SUPPLIER_EDIT],
};
/** Higher rank may manage lower ranks (a manager cannot create an owner). */
const RANK = { OPERATOR: 1, PURCHASE_MANAGER: 2, STOCK_MANAGER: 2, ACCOUNTANT: 2, MANAGER: 3, OWNER: 4, SUPER_ADMIN: 5 };
const can = (role, perm) => !!(ROLES[role] && ROLES[role].includes(perm));
const permsOf = (role) => ROLES[role] || [];
module.exports = { P, ROLES, RANK, can, permsOf };
