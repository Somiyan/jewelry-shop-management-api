const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  getPricingRules,
  updatePricingRules,
  getCurrentPrices,
  updatePrice,
  getPriceHistory,
} = require('../controllers/pricingController');

const router = express.Router();

router.get('/pricing', protect, getPricingRules);
router.put('/pricing', protect, authorize('admin', 'manager'), updatePricingRules);
router.get('/prices', getCurrentPrices);
router.post('/prices/update', protect, authorize('admin', 'manager'), updatePrice);
router.get('/prices/history/:metalType/:purity', getPriceHistory);

module.exports = router;
