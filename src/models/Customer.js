const mongoose = require('mongoose');

const purchaseSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now },
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    email: { type: String, trim: true, default: '' },
    address: { type: String, default: '' },
    billingAddress: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
    gstin: { type: String, trim: true, default: '' },
    communicationPreferences: {
      type: [String],
      enum: ['sms', 'email', 'whatsapp'],
      default: [],
    },
    loyaltyPoints: { type: Number, default: 0 },
    totalPurchases: { type: Number, default: 0 },
    purchases: { type: [purchaseSchema], default: [] },
    notes: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

module.exports = mongoose.model('Customer', customerSchema);
