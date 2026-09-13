const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    totalPrice: { type: Number, required: true },
    // Print-layout fields — snapshotted from the order item at invoice
    // creation, so the printed HSN/purity/weights/rate never drift if the
    // product record changes later.
    hsnCode: { type: String, default: '' },
    purity: { type: mongoose.Schema.Types.Mixed },
    grossWeight: { type: Number },
    netWeight: { type: Number },
    ratePerGram: { type: Number },
    labourCharge: { type: Number, default: 0 },

    // Sale-time snapshot for the GST-aware Sales module (see saleCalculationService).
    // Historical invoices predate these and simply don't carry them — read as
    // undefined, never backfilled/guessed, since there is no way to know what
    // a pre-existing invoice's "current cost at sale" actually was.
    currentCostAtSale: { type: Number },
    defaultMakingChargeType: { type: String, enum: ['percentage', 'per_gram'] },
    defaultMakingChargeValue: { type: Number },
    saleMakingChargeType: { type: String, enum: ['percentage', 'per_gram'] },
    saleMakingChargeValue: { type: Number },
    belowCurrentCostApproval: {
      approved: { type: Boolean },
      reason: { type: String },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      approvedAt: { type: Date },
    },
  },
  { _id: false }
);

// The shop's own "जुने सोने तपशील" (old gold exchange) record — a customer
// trading in old gold as part of the transaction. Purely a printed record of
// the exchange for the shop's paper trail; it does not feed into
// subtotal/tax/finalAmount, which stay defined purely by the sold items
// (the shop reconciles any trade-in credit separately, same as on paper).
const oldGoldExchangeSchema = new mongoose.Schema(
  {
    date: { type: Date },
    weight: { type: Number },
    rate: { type: Number },
    amount: { type: Number },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    invoiceDate: { type: Date, default: Date.now },
    items: { type: [invoiceItemSchema], default: [] },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    discountPercentage: { type: Number, default: 0 },
    taxAmount: { type: Number, required: true },
    finalAmount: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'upi', 'cheque', 'bank-transfer', 'other'],
      default: 'cash',
    },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'partial'], default: 'pending' },
    amountPaid: { type: Number, default: 0 },

    // GST vs Non-GST billing (see saleCalculationService / salesPolicy config).
    // Absent on invoices created before this existed — treated as GST for
    // display purposes only (that was the only kind of bill this app produced).
    billingType: { type: String, enum: ['GST', 'NON_GST'] },
    customerGstin: { type: String, trim: true, default: '' },
    shopGstin: { type: String, trim: true, default: '' },
    isInterState: { type: Boolean, default: false },
    cgstAmount: { type: Number, default: 0 },
    sgstAmount: { type: Number, default: 0 },
    igstAmount: { type: Number, default: 0 },

    oldGoldExchange: { type: oldGoldExchangeSchema, default: undefined },
    notes: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('Invoice', invoiceSchema);
