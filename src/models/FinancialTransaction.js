const mongoose = require('mongoose');

const financialTransactionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['sale', 'expense', 'purchase', 'return'], required: true },
    amount: { type: Number, required: true },
    category: { type: String, default: 'general' },
    description: { type: String, default: '' },
    relatedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    relatedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    paymentMethod: { type: String, default: 'cash' },
    date: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('FinancialTransaction', financialTransactionSchema);
