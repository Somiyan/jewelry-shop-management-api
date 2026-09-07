const mongoose = require('mongoose');

const pricingRuleSchema = new mongoose.Schema(
  {
    metalType: { type: String, enum: ['gold', 'silver'], required: true, unique: true },
    pricingStrategy: { type: String, enum: ['fixed', 'percentage', 'hybrid'], default: 'percentage' },
    fixedMarkupPerGram: { type: Number, default: 0 },
    percentageMarkup: { type: Number, default: 0 },
    laborCostPerGram: { type: Number, default: 0 },
    taxPercentage: { type: Number, default: 3 },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' } }
);

module.exports = mongoose.model('PricingRule', pricingRuleSchema);
