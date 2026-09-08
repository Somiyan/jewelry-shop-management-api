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
};

const ROLE_PERMISSIONS = {
  admin: Object.values(PERMISSIONS),
  manager: [
    PERMISSIONS.VIEW_RATES,
    PERMISSIONS.FETCH_LIVE_RATES,
    PERMISSIONS.EDIT_RATES,
    PERMISSIONS.VIEW_RATE_HISTORY,
  ],
  staff: [PERMISSIONS.VIEW_RATES, PERMISSIONS.VIEW_RATE_HISTORY],
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
