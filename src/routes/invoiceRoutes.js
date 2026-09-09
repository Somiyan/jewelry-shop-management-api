const express = require('express');
const { protect } = require('../middleware/auth');
const { authorizePermission, PERMISSIONS } = require('../middleware/permissions');
const {
  createInvoice,
  listInvoices,
  getInvoice,
  generatePdf,
  updatePaymentStatus,
  getInvoicePayments,
  addPayment,
  getInvoiceOutstanding,
} = require('../controllers/invoiceController');

const router = express.Router();

router.post('/', protect, createInvoice);
router.get('/', protect, listInvoices);
router.get('/generate-pdf/:id', protect, generatePdf);
router.get('/:id', protect, authorizePermission(PERMISSIONS.VIEW_INVOICE), getInvoice);
router.put('/:id/payment-status', protect, updatePaymentStatus);

router.get('/:id/outstanding', protect, authorizePermission(PERMISSIONS.VIEW_INVOICE), getInvoiceOutstanding);
router.get('/:id/payments', protect, authorizePermission(PERMISSIONS.VIEW_PAYMENT_HISTORY), getInvoicePayments);
router.post('/:id/payments', protect, authorizePermission(PERMISSIONS.ADD_PAYMENT), addPayment);

module.exports = router;
