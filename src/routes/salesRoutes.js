const express = require('express');
const { protect } = require('../middleware/auth');
const { checkout } = require('../controllers/salesController');

const router = express.Router();

router.post('/checkout', protect, checkout);

module.exports = router;
