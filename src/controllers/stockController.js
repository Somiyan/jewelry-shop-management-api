const asyncHandler = require('express-async-handler');
const Product = require('../models/Product');
const StockTransaction = require('../models/StockTransaction');
const { getStockLevel } = require('../utils/stockLevel');

const getStockStatus = asyncHandler(async (req, res) => {
  const products = await Product.find();
  const status = products.map((p) => ({
    productId: p._id,
    name: p.name,
    sku: p.sku,
    quantity: p.quantity,
    level: getStockLevel(p.quantity),
  }));
  res.json(status.filter((s) => s.level !== 'green'));
});

const logTransaction = asyncHandler(async (req, res) => {
  const { productId, type, quantity, costPerUnit, notes } = req.body;
  if (!productId || !type || quantity == null) {
    res.status(400);
    throw new Error('productId, type and quantity are required');
  }
  const product = await Product.findById(productId);
  if (!product) {
    res.status(404);
    throw new Error('Product not found');
  }

  const delta = type === 'sale' || type === 'return' ? -Math.abs(quantity) : Math.abs(quantity);
  product.quantity = Math.max(0, product.quantity + delta);
  await product.save();

  const transaction = await StockTransaction.create({
    productId,
    type,
    quantity: delta,
    costPerUnit,
    notes,
    performedBy: req.user && req.user._id,
  });
  res.status(201).json(transaction);
});

const getTransactionHistory = asyncHandler(async (req, res) => {
  const { productId } = req.query;
  const filter = productId ? { productId } : {};
  const history = await StockTransaction.find(filter).populate('productId', 'name sku').sort({ date: -1 });
  res.json(history);
});

module.exports = { getStockStatus, logTransaction, getTransactionHistory };
