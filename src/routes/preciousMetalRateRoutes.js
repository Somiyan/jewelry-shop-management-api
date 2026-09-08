const express = require('express');
const { protect } = require('../middleware/auth');
const { authorizePermission, PERMISSIONS } = require('../middleware/permissions');
const {
  getCurrentRates,
  getLiveRates,
  fetchAndStore,
  createRate,
  updateRate,
  getRateHistory,
  cronSync,
} = require('../controllers/preciousMetalRateController');

const router = express.Router();

// Public read, matching the existing /api/prices convention — the header
// ticker and dashboard read the current rate before a session exists.
router.get('/current', getCurrentRates);

// Authenticated by a shared secret rather than a JWT: the caller is Vercel
// Cron, which has no user identity. Declared before the parameterised routes.
router.post('/sync/cron', cronSync);

// Reads through to RapidAPI for a preview; stores nothing.
router.get('/live', protect, authorizePermission(PERMISSIONS.FETCH_LIVE_RATES), getLiveRates);
router.post('/fetch-and-store', protect, authorizePermission(PERMISSIONS.FETCH_LIVE_RATES), fetchAndStore);

router.get('/history', protect, authorizePermission(PERMISSIONS.VIEW_RATE_HISTORY), getRateHistory);

router.post('/', protect, authorizePermission(PERMISSIONS.EDIT_RATES), createRate);
router.put('/:id', protect, authorizePermission(PERMISSIONS.EDIT_RATES), updateRate);

module.exports = router;
