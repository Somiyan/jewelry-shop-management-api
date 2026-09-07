const asyncHandler = require('express-async-handler');
const Customer = require('../models/Customer');

const createCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.create(req.body);
  res.status(201).json(customer);
});

const listCustomers = asyncHandler(async (req, res) => {
  const { q } = req.query;
  const filter = q ? { $or: [{ name: new RegExp(q, 'i') }, { phone: new RegExp(q, 'i') }] } : {};
  const customers = await Customer.find(filter).sort({ createdAt: -1 });
  res.json(customers);
});

const getCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }
  res.json(customer);
});

const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }
  res.json(customer);
});

const searchByPhone = asyncHandler(async (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    res.status(400);
    throw new Error('phone query param is required');
  }
  const customers = await Customer.find({ phone: new RegExp(phone, 'i') });
  res.json(customers);
});

module.exports = { createCustomer, listCustomers, getCustomer, updateCustomer, searchByPhone };
