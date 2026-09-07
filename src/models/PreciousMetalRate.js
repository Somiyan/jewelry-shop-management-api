const mongoose = require('mongoose');

/**
 * Insert-only rate ledger for gold/silver. Never mutate an existing document —
 * every rate change is a brand new document. The "current" rate for a metal is
 * simply the most recently created document for that metalType. This gives us
 * full audit history for free via a sort-by-createdAt query, with no separate
 * history array to keep in sync.
 */
const preciousMetalRateSchema = new mongoose.Schema(
  {
    metalType: { type: String, enum: ['gold', 'silver'], required: true },
    ratePerGram: { type: Number, required: true, min: 0 },
    unit: { type: String, default: 'gram' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, default: '' },
    effectiveAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

preciousMetalRateSchema.index({ metalType: 1, createdAt: -1 });

module.exports = mongoose.model('PreciousMetalRate', preciousMetalRateSchema);
