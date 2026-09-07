const express = require('express');
const { protect } = require('../middleware/auth');
const { getStockStatus, logTransaction, getTransactionHistory } = require('../controllers/stockController');

const router = express.Router();

router.get('/status', protect, getStockStatus);
router.post('/transactions', protect, logTransaction);
router.get('/transactions/history', protect, getTransactionHistory);

module.exports = router;
