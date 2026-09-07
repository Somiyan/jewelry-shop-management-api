const mongoose = require('mongoose');

const priceHistorySchema = new mongoose.Schema(
  {
    price: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const metalPriceSchema = new mongoose.Schema({
  metalType: { type: String, enum: ['gold', 'silver'], required: true },
  purity: { type: String, enum: ['24K', '22K', '18K', '925'], required: true },
  spotPrice: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  source: { type: String, enum: ['manual', 'metals-api', 'finnhub'], default: 'manual' },
  lastUpdated: { type: Date, default: Date.now },
  priceHistory: { type: [priceHistorySchema], default: [] },
});

metalPriceSchema.index({ metalType: 1, purity: 1 }, { unique: true });

module.exports = mongoose.model('MetalPrice', metalPriceSchema);
