const express = require('express');
const multer = require('multer');
const { protect } = require('../middleware/auth');
const {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  updateStock,
  importProducts,
  pricingPreview,
} = require('../controllers/productController');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', protect, createProduct);
router.post('/import', protect, upload.single('file'), importProducts);
// Forward pricing calc is open to any authenticated user; the reverse-solve
// branch is gated for admin/manager *inside* the controller itself.
router.post('/pricing/preview', protect, pricingPreview);
router.get('/', listProducts);
router.get('/:id', getProduct);
router.put('/:id', protect, updateProduct);
router.delete('/:id', protect, deleteProduct);
router.patch('/:id/stock', protect, updateStock);

module.exports = router;
