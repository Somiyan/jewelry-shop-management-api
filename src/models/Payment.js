const mongoose = require('mongoose');

/**
 * A single payment recorded against an invoice. Insert-only ledger, same
 * pattern as Order.advancePayments and PreciousMetalRate: a payment is never
 * edited or deleted — it is voided by inserting a `status: 'reversed'` flag on
 * the same row, and a correction is a brand new row. This is what lets the
 * invoice's paid amount and the customer's outstanding balance be *derived*
 * rather than manually maintained, per the module's core rule.
 *
 * `amount` and every derived money figure elsewhere use plain `Number` values
 * rounded to 2dp via pricingService.round2, matching the rest of this
 * codebase's financial fields (Invoice.finalAmount, Order.totalAmount, the
 * PreciousMetalRate ledger) — introducing Decimal128 here alone would create
 * two money representations across one transaction (invoice + payment) for
 * no real precision gain at rupee-scale values.
 */
const paymentSchema = new mongoose.Schema(
  {
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },

    amount: { type: Number, required: true, min: 0.01 },
    method: {
      type: String,
      enum: ['cash', 'card', 'upi', 'cheque', 'bank-transfer', 'other'],
      default: 'cash',
    },
    date: { type: Date, default: Date.now },
    reference: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },

    /**
     * 'order-advance': carried over from Order.advancePayments when an order
     * with pre-collected deposits is converted to an invoice (see
     * invoiceController.createInvoice) — preserves each original deposit as
     * its own row instead of collapsing them into one opening balance.
     * 'manual': recorded directly against the invoice via the payments API.
     * 'legacy-migration': backfilled once from Invoice.amountPaid for
     * invoices created before per-payment records existed — see
     * src/utils/backfillInvoicePayments.js.
     */
    source: { type: String, enum: ['manual', 'order-advance', 'legacy-migration'], default: 'manual' },

    /** ACTIVE counts toward the invoice's paid amount; REVERSED does not. */
    status: { type: String, enum: ['ACTIVE', 'REVERSED'], default: 'ACTIVE', index: true },
    reversal: {
      reason: { type: String },
      reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reversedAt: { type: Date },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

paymentSchema.index({ invoiceId: 1, status: 1, date: 1 });
paymentSchema.index({ customerId: 1, date: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
