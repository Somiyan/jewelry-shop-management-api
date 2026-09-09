/**
 * Permission checks layered on top of the existing role system.
 *
 * The User model already carries a `permissions: [String]` array that nothing
 * consumed yet; this reuses it rather than inventing a parallel mechanism.
 * A user passes if their role grants the permission by default, or if the
 * permission is listed explicitly on their account. Admins pass everything.
 */
const PERMISSIONS = {
  VIEW_RATES: 'VIEW_RATES',
  FETCH_LIVE_RATES: 'FETCH_LIVE_RATES',
  EDIT_RATES: 'EDIT_RATES',
  VIEW_RATE_HISTORY: 'VIEW_RATE_HISTORY',

  VIEW_CUSTOMER_BALANCE: 'VIEW_CUSTOMER_BALANCE',
  VIEW_PURCHASE_HISTORY: 'VIEW_PURCHASE_HISTORY',
  VIEW_INVOICE: 'VIEW_INVOICE',
  ADD_PAYMENT: 'ADD_PAYMENT',
  VIEW_PAYMENT_HISTORY: 'VIEW_PAYMENT_HISTORY',
  EDIT_PAYMENT: 'EDIT_PAYMENT',
  REVERSE_PAYMENT: 'REVERSE_PAYMENT',

  ADJUST_MAKING_CHARGES: 'ADJUST_MAKING_CHARGES',
  APPROVE_BELOW_VALUE_SALE: 'APPROVE_BELOW_VALUE_SALE',
};

const ROLE_PERMISSIONS = {
  admin: Object.values(PERMISSIONS),
  manager: [
    PERMISSIONS.VIEW_RATES,
    PERMISSIONS.FETCH_LIVE_RATES,
    PERMISSIONS.EDIT_RATES,
    PERMISSIONS.VIEW_RATE_HISTORY,
    PERMISSIONS.VIEW_CUSTOMER_BALANCE,
    PERMISSIONS.VIEW_PURCHASE_HISTORY,
    PERMISSIONS.VIEW_INVOICE,
    PERMISSIONS.ADD_PAYMENT,
    PERMISSIONS.VIEW_PAYMENT_HISTORY,
    PERMISSIONS.EDIT_PAYMENT,
    PERMISSIONS.REVERSE_PAYMENT,
    PERMISSIONS.ADJUST_MAKING_CHARGES,
    PERMISSIONS.APPROVE_BELOW_VALUE_SALE,
  ],
  // Staff work the counter: they can see balances/history and take a payment,
  // but correcting or voiding one is reserved for manager/admin. Same for
  // negotiating a making charge or approving a below-value sale — both move
  // real margin and need a second pair of eyes.
  staff: [
    PERMISSIONS.VIEW_RATES,
    PERMISSIONS.VIEW_RATE_HISTORY,
    PERMISSIONS.VIEW_CUSTOMER_BALANCE,
    PERMISSIONS.VIEW_PURCHASE_HISTORY,
    PERMISSIONS.VIEW_INVOICE,
    PERMISSIONS.ADD_PAYMENT,
    PERMISSIONS.VIEW_PAYMENT_HISTORY,
  ],
};

function permissionsFor(user) {
  if (!user) return [];
  const fromRole = ROLE_PERMISSIONS[user.role] || [];
  const explicit = Array.isArray(user.permissions) ? user.permissions : [];
  return [...new Set([...fromRole, ...explicit])];
}

function userHasPermission(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return permissionsFor(user).includes(permission);
}

/** Express guard. Use after `protect`, which is what populates req.user. */
function authorizePermission(...required) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized, no token' });
    }
    const missing = required.filter((p) => !userHasPermission(req.user, p));
    if (missing.length > 0) {
      return res.status(403).json({ message: `Forbidden: requires ${missing.join(', ')}` });
    }
    next();
  };
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, permissionsFor, userHasPermission, authorizePermission };
