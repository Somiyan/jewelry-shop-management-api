const mongoose = require('mongoose');

const stockTransactionSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    type: { type: String, enum: ['sale', 'purchase', 'adjustment', 'return'], required: true },
    quantity: { type: Number, required: true },
    costPerUnit: { type: Number, default: 0 },
    date: { type: Date, default: Date.now },
    notes: { type: String, default: '' },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('StockTransaction', stockTransactionSchema);
