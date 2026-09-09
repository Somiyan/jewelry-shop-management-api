const express = require('express');
const { protect } = require('../middleware/auth');
const { authorizePermission, PERMISSIONS } = require('../middleware/permissions');
const {
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
  searchByPhone,
  getCustomerSummary,
  getCustomerPurchases,
  getCustomerLedger,
  getCustomerPayments,
} = require('../controllers/customerController');

const router = express.Router();

router.post('/', protect, createCustomer);
router.get('/', protect, authorizePermission(PERMISSIONS.VIEW_CUSTOMER_BALANCE), listCustomers);
router.get('/search', protect, searchByPhone);
router.get('/:id', protect, getCustomer);
router.put('/:id', protect, updateCustomer);

router.get('/:id/summary', protect, authorizePermission(PERMISSIONS.VIEW_CUSTOMER_BALANCE), getCustomerSummary);
router.get('/:id/purchases', protect, authorizePermission(PERMISSIONS.VIEW_PURCHASE_HISTORY), getCustomerPurchases);
router.get('/:id/ledger', protect, authorizePermission(PERMISSIONS.VIEW_PURCHASE_HISTORY), getCustomerLedger);
router.get('/:id/payments', protect, authorizePermission(PERMISSIONS.VIEW_PAYMENT_HISTORY), getCustomerPayments);

module.exports = router;
