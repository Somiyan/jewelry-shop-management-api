const asyncHandler = require('express-async-handler');
const PreciousMetalRate = require('../models/PreciousMetalRate');

const METAL_TYPES = ['gold', 'silver'];

async function currentRateFor(metalType) {
  return PreciousMetalRate.findOne({ metalType })
    .sort({ createdAt: -1 })
    .populate('updatedBy', 'username email role');
}

const getCurrentRates = asyncHandler(async (req, res) => {
  const [gold, silver] = await Promise.all([currentRateFor('gold'), currentRateFor('silver')]);
  res.json({ gold: gold || null, silver: silver || null });
});

const createRate = asyncHandler(async (req, res) => {
  const { metalType, ratePerGram, reason, unit } = req.body;
  if (!metalType || !METAL_TYPES.includes(metalType)) {
    res.status(400);
    throw new Error(`metalType is required and must be one of ${METAL_TYPES.join(', ')}`);
  }
  if (ratePerGram == null || Number(ratePerGram) < 0) {
    res.status(400);
    throw new Error('ratePerGram is required and must be a non-negative number');
  }

  // Never mutate an existing rate — always insert a new document so we retain
  // full audit history for free.
  const rate = await PreciousMetalRate.create({
    metalType,
    ratePerGram: Number(ratePerGram),
    unit: unit || 'gram',
    reason: reason || '',
    updatedBy: req.user && req.user._id,
  });
  res.status(201).json(rate);
});

const getRateHistory = asyncHandler(async (req, res) => {
  const { metal, limit, before, updatedBy } = req.query;
  const filter = {};
  if (metal) filter.metalType = metal;
  if (updatedBy) filter.updatedBy = updatedBy;
  if (before) filter.createdAt = { $lt: new Date(before) };

  const lim = limit ? Math.min(Number(limit) || 50, 200) : 50;

  const history = await PreciousMetalRate.find(filter)
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate('updatedBy', 'username email role');

  res.json(history);
});

module.exports = { getCurrentRates, createRate, getRateHistory };
