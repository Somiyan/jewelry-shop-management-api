const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { getCurrentRates, createRate, getRateHistory } = require('../controllers/preciousMetalRateController');

const router = express.Router();

// Matches the existing /api/prices convention (public read) for consistency —
// the header ticker/dashboard read this without auth.
router.get('/current', getCurrentRates);
router.post('/', protect, authorize('admin', 'manager'), createRate);
router.get('/history', protect, getRateHistory);

module.exports = router;
