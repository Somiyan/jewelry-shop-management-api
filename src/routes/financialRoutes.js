const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getDashboard,
  getRevenue,
  getProfitLoss,
  getTransactions,
  getInventoryValue,
} = require('../controllers/financialController');

const router = express.Router();

router.get('/dashboard', protect, getDashboard);
router.get('/revenue', protect, getRevenue);
router.get('/profit-loss', protect, getProfitLoss);
router.get('/transactions', protect, getTransactions);
router.get('/inventory-value', protect, getInventoryValue);

module.exports = router;
