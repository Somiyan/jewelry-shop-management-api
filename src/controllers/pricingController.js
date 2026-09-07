const asyncHandler = require('express-async-handler');
const PricingRule = require('../models/PricingRule');
const MetalPrice = require('../models/MetalPrice');

const getPricingRules = asyncHandler(async (req, res) => {
  const rules = await PricingRule.find();
  res.json(rules);
});

const updatePricingRules = asyncHandler(async (req, res) => {
  const { metalType, ...updates } = req.body;
  if (!metalType) {
    res.status(400);
    throw new Error('metalType is required');
  }
  const rule = await PricingRule.findOneAndUpdate(
    { metalType },
    { $set: updates },
    { new: true, upsert: true, runValidators: true }
  );
  res.json(rule);
});

const getCurrentPrices = asyncHandler(async (req, res) => {
  const prices = await MetalPrice.find().select('-priceHistory');
  res.json(prices);
});

const updatePrice = asyncHandler(async (req, res) => {
  const { metalType, purity, spotPrice, source } = req.body;
  if (!metalType || !purity || spotPrice == null) {
    res.status(400);
    throw new Error('metalType, purity and spotPrice are required');
  }
  const existing = await MetalPrice.findOne({ metalType, purity });
  if (existing) {
    existing.priceHistory.push({ price: existing.spotPrice, timestamp: existing.lastUpdated });
    existing.spotPrice = spotPrice;
    existing.source = source || 'manual';
    existing.lastUpdated = new Date();
    await existing.save();
    return res.json(existing);
  }
  const created = await MetalPrice.create({
    metalType,
    purity,
    spotPrice,
    source: source || 'manual',
    lastUpdated: new Date(),
  });
  res.status(201).json(created);
});

const getPriceHistory = asyncHandler(async (req, res) => {
  const { metalType, purity } = req.params;
  const record = await MetalPrice.findOne({ metalType, purity });
  if (!record) {
    res.status(404);
    throw new Error('No price record found');
  }
  res.json(record.priceHistory);
});

module.exports = { getPricingRules, updatePricingRules, getCurrentPrices, updatePrice, getPriceHistory };
