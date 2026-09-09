const express = require('express');
const { protect } = require('../middleware/auth');
const { checkout, calculateSalePreview, getSalesPolicy } = require('../controllers/salesController');

const router = express.Router();

router.get('/policy', protect, getSalesPolicy);
router.post('/calculate', protect, calculateSalePreview);
router.post('/checkout', protect, checkout);

module.exports = router;
