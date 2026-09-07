const express = require('express');
const { protect } = require('../middleware/auth');
const {
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
  searchByPhone,
} = require('../controllers/customerController');

const router = express.Router();

router.post('/', protect, createCustomer);
router.get('/', protect, listCustomers);
router.get('/search', protect, searchByPhone);
router.get('/:id', protect, getCustomer);
router.put('/:id', protect, updateCustomer);

module.exports = router;
