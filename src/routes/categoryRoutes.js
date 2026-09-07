const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { createCategory, listCategories, updateCategory } = require('../controllers/categoryController');

const router = express.Router();

router.post('/', protect, authorize('admin', 'manager'), createCategory);
router.get('/', listCategories);
router.put('/:id', protect, authorize('admin', 'manager'), updateCategory);

module.exports = router;
