const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    // required: true REMOVED — a custom/made-to-order item has no Product yet.
    // Presence is validated at the controller level, conditioned on isCustomOrder.
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    metalType: { type: String, required: true },
    purity: { type: mongoose.Schema.Types.Mixed, required: true },
    weightGrams: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    spotPrice: { type: Number, required: true },
    markup: { type: Number, required: true },
    laborCost: { type: Number, required: true },
    tax: { type: Number, required: true },
    finalPrice: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    // Snapshotted at sale time for invoice printing — see Product for the
    // live-editable source values.
    hsnCode: { type: String, default: '' },
    grossWeight: { type: Number },
    netWeight: { type: Number },
    ratePerGram: { type: Number },

    // ---- Custom / made-to-order workflow fields ----
    // Coexists with the stock-linked shape above; when isCustomOrder is true
    // there is no Product yet (productId stays unset until conversion).
    isCustomOrder: { type: Boolean, default: false },
    category: { type: String, default: '' }, // from Category Master, for custom items
    description: { type: String, default: '' }, // customer requirement / karigar notes, multiline
    sizeValue: { type: Number },
    sizeUnit: { type: String, enum: ['mm', 'cm', 'inch', 'size', 'custom'] },
    wastagePercentage: { type: Number, default: 0 },
    estimatedWeight: { type: Number }, // the initial customer-facing estimate (== weightGrams at creation)
    // The making-charge terms actually quoted to the customer at order time —
    // frozen, never overwritten. "Mark ready" must fall back to THESE, not a
    // hardcoded default, or a staff member who only updates weights would
    // silently reprice the item at 0% making charge.
    makingChargeType: { type: String, enum: ['percentage', 'per_gram'] },
    makingChargeValue: { type: Number },
    estimatedPrice: { type: Number }, // frozen snapshot of finalPrice at order-creation time, never overwritten
    fulfillmentStatus: { type: String, enum: ['pending', 'ready', 'converted'], default: 'pending' },
    // Populated only once "mark ready" happens:
    finalGrossWeight: { type: Number },
    finalNetWeight: { type: Number },
    finalPurity: { type: Number },
    finalMakingChargeType: { type: String, enum: ['percentage', 'per_gram'] },
    finalMakingChargeValue: { type: Number },
    finalGoldRate: { type: Number },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    orderDate: { type: Date, default: Date.now },
    deliveryDate: { type: Date },
    status: {
      type: String,
      // Additive extension for the custom/made-to-order workflow — every
      // existing value is preserved exactly, nothing renamed or removed.
      enum: [
        'pending',
        'confirmed',
        'processing',
        'ready',
        'delivered',
        'draft',
        'in_manufacturing',
        'completed',
        'cancelled',
      ],
      default: 'pending',
    },
    items: { type: [orderItemSchema], default: [] },
    totalAmount: { type: Number, required: true, default: 0 },
    discount: { type: Number, default: 0 },
    notes: { type: String, default: '' },
    // Advance/token payments taken against a made-to-order (or any) order.
    // Insert-only ledger — a customer may pay a token in several installments
    // while a piece is being manufactured, so this is never a single snapshot
    // (same convention as PreciousMetalRate: append, never overwrite). The
    // total collected is a virtual sum below, not a stored/duplicated field.
    advancePayments: {
      type: [
        new mongoose.Schema(
          {
            amount: { type: Number, required: true, min: 0 },
            method: {
              type: String,
              enum: ['cash', 'card', 'upi', 'cheque', 'bank-transfer', 'other'],
              default: 'cash',
            },
            date: { type: Date, default: Date.now },
            reference: { type: String, default: '' },
            notes: { type: String, default: '' },
            recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          },
          { _id: true, timestamps: { createdAt: true, updatedAt: false } }
        ),
      ],
      default: [],
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('Order', orderSchema);
