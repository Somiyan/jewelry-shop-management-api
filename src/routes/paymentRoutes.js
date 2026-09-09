const express = require('express');
const { protect } = require('../middleware/auth');
const { authorizePermission, PERMISSIONS } = require('../middleware/permissions');
const { editPayment, reversePaymentHandler, getReceipt } = require('../controllers/paymentController');

const router = express.Router();

router.get('/:id/receipt', protect, authorizePermission(PERMISSIONS.VIEW_PAYMENT_HISTORY), getReceipt);
router.put('/:id', protect, authorizePermission(PERMISSIONS.EDIT_PAYMENT), editPayment);
router.post('/:id/reverse', protect, authorizePermission(PERMISSIONS.REVERSE_PAYMENT), reversePaymentHandler);

module.exports = router;
