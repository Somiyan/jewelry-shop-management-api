const mongoose = require('mongoose');

/**
 * Insert-only rate ledger for gold/silver. Never mutate an existing document's
 * rate — every rate change is a brand new document. The "current" rate for a
 * metal is simply the most recently created document for that metalType. This
 * gives us full audit history for free via a sort-by-createdAt query, with no
 * separate history array to keep in sync.
 *
 * `status` is the one field that is updated after insert: when a newer rate
 * arrives the previous ACTIVE row is marked SUPERSEDED. That is a lifecycle
 * flag only — the recorded rate, its source and its author are immutable.
 *
 * The stored `ratePerGram` is always the PURE (24K / 999) per-gram rate in INR,
 * because the pricing engine applies the item's own purity percentage on top.
 */
const preciousMetalRateSchema = new mongoose.Schema(
  {
    metalType: { type: String, enum: ['gold', 'silver'], required: true },
    ratePerGram: { type: Number, required: true, min: 0 },
    unit: { type: String, default: 'gram' },
    currency: { type: String, default: 'INR' },
    city: { type: String, default: 'Mumbai' },

    /** Human-readable origin, e.g. 'RapidAPI' or 'manual'. */
    source: { type: String, default: 'manual' },
    /** Machine-readable origin used for filtering and badges. */
    sourceType: { type: String, enum: ['LIVE_API', 'MANUAL'], default: 'MANUAL', index: true },
    /** ACTIVE = the current rate for this metal. Exactly one per metal. */
    status: { type: String, enum: ['ACTIVE', 'SUPERSEDED'], default: 'ACTIVE', index: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, default: '' },

    /** When the rate takes effect commercially (provider's own timestamp for live rates). */
    effectiveAt: { type: Date, default: Date.now },
    /** When we actually called the provider. Null for manual entries. */
    fetchedAt: { type: Date, default: null },

    /**
     * What the provider actually said, plus how we interpreted it. Kept so a
     * disputed rate can be traced back to the raw quote and the conversion
     * applied to it. Never contains credentials.
     */
    providerMeta: {
      sourcePath: { type: String },
      rawValue: { type: Number },
      quotedGrams: { type: Number },
      purityToken: { type: String },
      purityFraction: { type: Number },
      unitInferred: { type: Boolean },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Current-rate lookup and history listing.
preciousMetalRateSchema.index({ metalType: 1, createdAt: -1 });
// Fast "which row is live right now" lookup.
preciousMetalRateSchema.index({ metalType: 1, status: 1, createdAt: -1 });

/** Uppercase metal name, as used by the documented /api/rates contract. */
preciousMetalRateSchema.virtual('metal').get(function metal() {
  return this.metalType ? this.metalType.toUpperCase() : null;
});

/** Alias of ratePerGram, as used by the documented /api/rates contract. */
preciousMetalRateSchema.virtual('rate').get(function rate() {
  return this.ratePerGram;
});

module.exports = mongoose.model('PreciousMetalRate', preciousMetalRateSchema);
