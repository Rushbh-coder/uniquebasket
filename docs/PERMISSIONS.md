# Roles & permissions
Enforced by the server on every request (`server/auth/rbac.js`); the screens only hide what you cannot use.

| Permission | OPERATOR | MANAGER | OWNER / SUPER_ADMIN | ACCOUNTANT | STOCK_MANAGER | PURCHASE_MANAGER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Create bill, hold, own history | ✔ | ✔ | ✔ | | | |
| See all bills | | ✔ | ✔ | ✔ | | |
| Reprint (logged) | ✔¹ | ✔ | ✔ | | | |
| Discount up to own limit | ✔ (2%) | ✔ (10%) | ✔ (100%) | | | |
| Manual weight / change rate | PIN² | ✔ | ✔ | | | |
| Cancel / return bill | PIN² | ✔ | ✔ | | | |
| Credit sale (customer with credit) | ✔ | ✔ | ✔ | | | |
| Create customer | ✔ | ✔ | ✔ | | | |
| Edit customer credit, receive payments | | ✔ | ✔ | ✔ (payments) | | |
| Products, rates, price history | view | ✔ | ✔ | view | view | view |
| Purchases, suppliers | | ✔ | ✔ | | ✔ | ✔ |
| Stock adjust / wastage | | ✔ | ✔ | | ✔ | |
| Dashboard, sales reports | | ✔ | ✔ | ✔ | dashboard | |
| Profit / margin report, purchase rates on bills | | | ✔ | ✔ | | |
| Users, counters, settings, backup, audit | | ✔ | ✔ | audit | | |

¹ switchable in Settings. ² with a manager's username + PIN typed on the counter (approval is valid 3 minutes, recorded with the approver's name).
Limits in Settings → Discount limits. Managers cannot create or edit users with a higher role. Disabling a user or changing a role ends their sessions immediately.
Every sensitive action is in **Audit log** (login/logout/failed login, price change, manual rate/weight, overrides, cancel, return, reprint, stock adjust, wastage, users, permissions, settings, backup/restore).
