const express = require('express');
const { protect } = require('../middleware/auth');
const {
  createInvoice,
  listInvoices,
  getInvoice,
  generatePdf,
  updatePaymentStatus,
} = require('../controllers/invoiceController');

const router = express.Router();

router.post('/', protect, createInvoice);
router.get('/', protect, listInvoices);
router.get('/generate-pdf/:id', protect, generatePdf);
router.get('/:id', protect, getInvoice);
router.put('/:id/payment-status', protect, updatePaymentStatus);

module.exports = router;
