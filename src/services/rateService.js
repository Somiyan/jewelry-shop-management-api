const PreciousMetalRate = require('../models/PreciousMetalRate');
const AuditLog = require('../models/AuditLog');
const { fetchLiveRates } = require('../integrations/rateProviderClient');
const { config } = require('../config/rateProvider');

const METAL_TYPES = ['gold', 'silver'];

/** How long a stored rate stays trustworthy before the UI calls it stale. */
const STALE_AFTER_HOURS = Number(process.env.RATE_STALE_AFTER_HOURS || 36);

/** The live rate for a metal: newest record wins, regardless of status flags. */
async function currentRateFor(metalType, session) {
  return PreciousMetalRate.findOne({ metalType })
    .sort({ createdAt: -1 })
    .session(session || null)
    .populate('updatedBy', 'username email role');
}

async function currentRates() {
  const [gold, silver] = await Promise.all([currentRateFor('gold'), currentRateFor('silver')]);
  return { gold: gold || null, silver: silver || null };
}

/** LIVE / MANUAL / STALE, derived rather than stored so it can never go out of date. */
function rateStatusLabel(rate) {
  if (!rate) return 'NONE';
  const reference = rate.effectiveAt || rate.createdAt;
  const ageHours = (Date.now() - new Date(reference).getTime()) / 36e5;
  if (ageHours > STALE_AFTER_HOURS) return 'STALE';
  return rate.sourceType === 'LIVE_API' ? 'LIVE' : 'MANUAL';
}

/**
 * Idempotency guard for the cron: the same rate at the same effective instant
 * is the same fact, so re-running the job (a retry, a manual trigger minutes
 * later) must not add a second row saying it again.
 */
async function isDuplicateOfCurrent(metalType, ratePerGram, effectiveAt) {
  const latest = await PreciousMetalRate.findOne({ metalType }).sort({ createdAt: -1 });
  if (!latest) return false;
  if (Number(latest.ratePerGram) !== Number(ratePerGram)) return false;
  const a = new Date(latest.effectiveAt || latest.createdAt).getTime();
  const b = new Date(effectiveAt).getTime();
  return Math.floor(a / 1000) === Math.floor(b / 1000);
}

/**
 * Appends a new rate record and demotes the previous ACTIVE row for that metal.
 *
 * Insert happens first on purpose: if the demotion then fails we are left with
 * two ACTIVE rows, which is cosmetic because the current rate is resolved by
 * recency. Demoting first would risk leaving no ACTIVE row at all.
 */
async function recordRate({
  metalType,
  ratePerGram,
  sourceType = 'MANUAL',
  source = 'manual',
  reason = '',
  userId = null,
  effectiveAt = null,
  fetchedAt = null,
  city = null,
  currency = 'INR',
  unit = 'gram',
  providerMeta = undefined,
}) {
  if (!METAL_TYPES.includes(metalType)) {
    throw new Error(`metalType must be one of ${METAL_TYPES.join(', ')}`);
  }
  const value = Number(ratePerGram);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('ratePerGram must be a number greater than zero');
  }

  const previous = await PreciousMetalRate.findOne({ metalType }).sort({ createdAt: -1 });

  const created = await PreciousMetalRate.create({
    metalType,
    ratePerGram: value,
    unit,
    currency,
    city: city || 'Mumbai',
    source,
    sourceType,
    status: 'ACTIVE',
    reason,
    updatedBy: userId || undefined,
    effectiveAt: effectiveAt || new Date(),
    fetchedAt: fetchedAt || null,
    providerMeta,
  });

  await PreciousMetalRate.updateMany(
    { metalType, status: 'ACTIVE', _id: { $ne: created._id } },
    { $set: { status: 'SUPERSEDED' } }
  );

  // Rate changes move money, so they land in the shared audit trail too — the
  // ledger records what the rate became, the audit log records what changed.
  await AuditLog.create({
    entity: 'PreciousMetalRate',
    entityId: created._id,
    field: 'ratePerGram',
    oldValue: previous ? previous.ratePerGram : null,
    newValue: value,
    userId: userId || undefined,
    reason: reason || `${sourceType} rate update`,
  });

  return created;
}

/**
 * Fetches from the provider WITHOUT writing anything. Backs the preview shown
 * before the user commits to storing a rate.
 */
async function previewLiveRates({ city } = {}) {
  const live = await fetchLiveRates({ city: city || config.city });
  return {
    city: live.city,
    effectiveAt: live.effectiveAt,
    fetchedAt: new Date(),
    attempts: live.attempts,
    warnings: live.warnings,
    gold: live.gold ? { metal: 'GOLD', ratePerGram: live.gold.ratePerGram, unit: 'gram', currency: 'INR', provenance: live.gold } : null,
    silver: live.silver ? { metal: 'SILVER', ratePerGram: live.silver.ratePerGram, unit: 'gram', currency: 'INR', provenance: live.silver } : null,
  };
}

/**
 * Fetches from the provider and stores what it returns.
 *
 * A provider failure throws before anything is written, so a bad fetch can
 * never blank out or overwrite the last known good rate — the stored rate
 * simply stays where it was.
 */
async function fetchAndStoreRates({ userId = null, city, reason = 'Live rate sync' } = {}) {
  const live = await fetchLiveRates({ city: city || config.city });
  const fetchedAt = new Date();

  const stored = [];
  const skipped = [];

  for (const metalType of METAL_TYPES) {
    const quote = live[metalType];
    if (!quote) continue;

    if (await isDuplicateOfCurrent(metalType, quote.ratePerGram, live.effectiveAt)) {
      skipped.push({ metalType, ratePerGram: quote.ratePerGram, reason: 'unchanged at same effective time' });
      continue;
    }

    const created = await recordRate({
      metalType,
      ratePerGram: quote.ratePerGram,
      sourceType: 'LIVE_API',
      source: 'RapidAPI',
      reason,
      userId,
      effectiveAt: live.effectiveAt,
      fetchedAt,
      city: live.city,
      providerMeta: {
        sourcePath: quote.sourcePath,
        rawValue: quote.rawValue,
        quotedGrams: quote.quotedGrams,
        purityToken: quote.purityToken,
        purityFraction: quote.purityFraction,
        unitInferred: quote.unitInferred,
      },
    });
    stored.push(created);
  }

  return { stored, skipped, warnings: live.warnings, attempts: live.attempts, fetchedAt };
}

module.exports = {
  METAL_TYPES,
  STALE_AFTER_HOURS,
  currentRateFor,
  currentRates,
  rateStatusLabel,
  isDuplicateOfCurrent,
  recordRate,
  previewLiveRates,
  fetchAndStoreRates,
};
