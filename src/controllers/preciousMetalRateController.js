const asyncHandler = require('express-async-handler');
const PreciousMetalRate = require('../models/PreciousMetalRate');
const {
  METAL_TYPES,
  currentRates,
  rateStatusLabel,
  recordRate,
  previewLiveRates,
  fetchAndStoreRates,
} = require('../services/rateService');
const { runRateSync } = require('../jobs/rateSyncJob');
const { config } = require('../config/rateProvider');

/** Adds the derived LIVE/MANUAL/STALE badge without dropping any stored field. */
function withStatusLabel(doc) {
  if (!doc) return null;
  const obj = doc.toJSON ? doc.toJSON() : doc;
  return { ...obj, statusLabel: rateStatusLabel(doc) };
}

/**
 * GET /api/rates/current  (alias: /api/precious-metal-rates/current)
 * The rates the shop is currently trading on. Public, like /api/prices — the
 * header ticker reads this on every page load.
 */
const getCurrentRates = asyncHandler(async (req, res) => {
  const { gold, silver } = await currentRates();
  res.json({
    gold: withStatusLabel(gold),
    silver: withStatusLabel(silver),
    liveRatesAvailable: config.isConfigured(),
  });
});

/**
 * GET /api/rates/live
 * Reads through to the provider and returns what it says. Deliberately does
 * NOT write: the user previews the market rate, then decides whether to adopt it.
 */
const getLiveRates = asyncHandler(async (req, res) => {
  try {
    console.log('Previewing live rates...')
    const preview = await previewLiveRates({ city: req.query.city });
    res.json(preview);
  } catch (err) {
    // 502: our service is fine, the upstream one is not.
    res.status(502);
    throw new Error(err.message);
  }
});

/**
 * POST /api/rates/fetch-and-store
 * Fetch, validate, normalize, then persist. A provider failure aborts before
 * any write, so the last known good rate always survives.
 */
const fetchAndStore = asyncHandler(async (req, res) => {
  try {
    const result = await fetchAndStoreRates({
      userId: req.user && req.user._id,
      city: req.body && req.body.city,
      reason: (req.body && req.body.reason) || 'Live rate fetched and stored',
    });
    const { gold, silver } = await currentRates();
    res.status(201).json({
      stored: result.stored.map(withStatusLabel),
      skipped: result.skipped,
      warnings: result.warnings,
      current: { gold: withStatusLabel(gold), silver: withStatusLabel(silver) },
    });
  } catch (err) {
    res.status(502);
    throw new Error(err.message);
  }
});

/**
 * POST /api/rates  (alias: /api/precious-metal-rates)
 * Manual rate entry. Appends a record; never edits one in place.
 */
const createRate = asyncHandler(async (req, res) => {
  const { metalType, ratePerGram, reason, unit, effectiveAt, city } = req.body;
  if (!metalType || !METAL_TYPES.includes(metalType)) {
    res.status(400);
    throw new Error(`metalType is required and must be one of ${METAL_TYPES.join(', ')}`);
  }
  if (ratePerGram == null || !Number.isFinite(Number(ratePerGram)) || Number(ratePerGram) <= 0) {
    res.status(400);
    throw new Error('ratePerGram is required and must be a number greater than zero');
  }

  const rate = await recordRate({
    metalType,
    ratePerGram: Number(ratePerGram),
    unit: unit || 'gram',
    reason: reason || '',
    userId: req.user && req.user._id,
    sourceType: 'MANUAL',
    source: 'manual',
    effectiveAt: effectiveAt ? new Date(effectiveAt) : new Date(),
    city,
  });
  res.status(201).json(withStatusLabel(rate));
});

/**
 * PUT /api/rates/:id
 * "Editing" a rate appends a corrected record that supersedes the one named,
 * rather than rewriting history: the original figure stays queryable, and the
 * correction records who made it and why.
 */
const updateRate = asyncHandler(async (req, res) => {
  const existing = await PreciousMetalRate.findById(req.params.id);
  if (!existing) {
    res.status(404);
    throw new Error('Rate not found');
  }

  const { ratePerGram, reason, effectiveAt } = req.body;
  if (ratePerGram == null || !Number.isFinite(Number(ratePerGram)) || Number(ratePerGram) <= 0) {
    res.status(400);
    throw new Error('ratePerGram is required and must be a number greater than zero');
  }
  if (!reason || !String(reason).trim()) {
    res.status(400);
    throw new Error('reason is required when adjusting a rate manually');
  }

  const rate = await recordRate({
    metalType: existing.metalType,
    ratePerGram: Number(ratePerGram),
    unit: existing.unit,
    currency: existing.currency,
    city: existing.city,
    reason: String(reason).trim(),
    userId: req.user && req.user._id,
    sourceType: 'MANUAL',
    source: 'manual',
    effectiveAt: effectiveAt ? new Date(effectiveAt) : new Date(),
  });

  res.status(201).json({ rate: withStatusLabel(rate), supersededId: existing._id });
});

/**
 * GET /api/rates/history
 * Filters: metal, sourceType, updatedBy, from, to, limit, before (cursor).
 */
const getRateHistory = asyncHandler(async (req, res) => {
  const { metal, metalType, limit, before, updatedBy, sourceType, from, to } = req.query;
  const filter = {};

  const requestedMetal = metal || metalType;
  if (requestedMetal) {
    const normalized = String(requestedMetal).toLowerCase();
    if (!METAL_TYPES.includes(normalized)) {
      res.status(400);
      throw new Error(`metal must be one of ${METAL_TYPES.join(', ')}`);
    }
    filter.metalType = normalized;
  }
  if (updatedBy) filter.updatedBy = updatedBy;
  if (sourceType) {
    const normalized = String(sourceType).toUpperCase();
    if (!['LIVE_API', 'MANUAL'].includes(normalized)) {
      res.status(400);
      throw new Error('sourceType must be LIVE_API or MANUAL');
    }
    filter.sourceType = normalized;
  }

  // `before` is a keyset cursor; `from`/`to` are a reporting date range.
  const createdAt = {};
  if (before) createdAt.$lt = new Date(before);
  if (from) createdAt.$gte = new Date(from);
  if (to) createdAt.$lte = new Date(to);
  if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;

  const lim = limit ? Math.min(Number(limit) || 50, 200) : 50;

  const history = await PreciousMetalRate.find(filter)
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate('updatedBy', 'username email role');

  res.json(history.map(withStatusLabel));
});

/**
 * POST /api/rates/sync/cron
 * Called by Vercel Cron (which cannot present a JWT), authenticated with a
 * shared secret instead. Returns 200 even on a provider failure so the
 * scheduler does not treat an upstream outage as a broken endpoint.
 */
const cronSync = asyncHandler(async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(503);
    throw new Error('CRON_SECRET is not configured on the server');
  }

  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const provided = bearer || req.headers['x-cron-secret'];
  if (provided !== expected) {
    res.status(401);
    throw new Error('Invalid cron credentials');
  }

  const result = await runRateSync({ trigger: 'cron' });
  res.json(result);
});

module.exports = {
  getCurrentRates,
  getLiveRates,
  fetchAndStore,
  createRate,
  updateRate,
  getRateHistory,
  cronSync,
};
