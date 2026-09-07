const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  createOrder,
  listOrders,
  getOrder,
  updateOrder,
  updateStatus,
  listByStatus,
  markItemReady,
  convertItemToProduct,
  addAdvancePayment,
} = require('../controllers/orderController');

const router = express.Router();

router.post('/', protect, createOrder);
router.get('/', protect, listOrders);
router.get('/by-status/:status', protect, listByStatus);
router.get('/:id', protect, getOrder);
router.put('/:id', protect, updateOrder);
router.patch('/:id/status', protect, updateStatus);
// Custom/made-to-order lifecycle. Role-gating for restricted fields
// (wastage/making-charge/gold-rate overrides) happens inside the controller
// since it's field-level, not endpoint-level, for the /ready route.
router.patch('/:id/items/:itemIndex/ready', protect, markItemReady);
router.post('/:id/items/:itemIndex/convert-to-product', protect, authorize('admin', 'manager'), convertItemToProduct);
// A customer may pay a token/advance in installments — this appends to the
// ledger rather than overwriting a single snapshot. Admin/manager gating for
// exceeding the order total happens inside the controller (same pattern as
// the initial-advance check in createOrder).
router.post('/:id/advance-payments', protect, addAdvancePayment);

module.exports = router;
