const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const AuditLog = require('../models/AuditLog');
const { round2 } = require('./pricingService');
const { applySaleToOrders } = require('./orderLifecycleService');

const PAYMENT_METHODS = ['cash', 'card', 'upi', 'cheque', 'bank-transfer', 'other'];

/** Sum of ACTIVE (non-reversed) payments for one invoice. The single source of truth for "paid". */
async function totalPaidFor(invoiceId, session) {
  const [row] = await Payment.aggregate([
    { $match: { invoiceId: new mongoose.Types.ObjectId(invoiceId), status: 'ACTIVE' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]).session(session || null);
  return round2(row ? row.total : 0);
}

/** Unpaid / partial / paid, purely a function of amount paid vs invoice total — never stored as an independent choice. */
function deriveStatus(amountPaid, finalAmount) {
  if (amountPaid <= 0) return 'pending';
  if (amountPaid >= finalAmount) return 'paid';
  return 'partial';
}

/**
 * Recomputes and persists Invoice.amountPaid / paymentStatus from the Payment
 * ledger. `amountPaid`/`paymentStatus` stay on the Invoice document (matching
 * the existing schema and every UI that already reads them) but are only ever
 * written here, from the ledger — never accepted directly from a client.
 */
async function recomputeInvoiceFinancials(invoiceId, session) {
  const invoice = await Invoice.findById(invoiceId).session(session || null);
  if (!invoice) throw new Error('Invoice not found');

  const amountPaid = await totalPaidFor(invoiceId, session);
  const paymentStatus = deriveStatus(amountPaid, invoice.finalAmount);

  const changed = invoice.amountPaid !== amountPaid || invoice.paymentStatus !== paymentStatus;
  if (changed) {
    invoice.amountPaid = amountPaid;
    invoice.paymentStatus = paymentStatus;
    await invoice.save({ session });
  }
  return invoice;
}

/**
 * Records one payment against an invoice and brings the invoice's derived
 * fields back in sync, atomically. Steps mirror the module's transaction-
 * safety requirement: validate invoice/customer, validate the amount against
 * the outstanding balance, write the payment, recompute the invoice, run the
 * post-payment order lifecycle, audit-log it — all inside one session, so a
 * failure partway through leaves nothing half-written.
 *
 * `allowOverpayment` exists only for the order-advance carry-over at invoice
 * creation time (a historical fact being recorded, not a new transaction
 * being validated) — the public payments API never sets it.
 */
async function recordPayment({
  invoiceId,
  amount,
  method = 'cash',
  date,
  reference = '',
  notes = '',
  source = 'manual',
  userId = null,
  allowOverpayment = false,
  session: externalSession,
}) {
  const value = round2(Number(amount));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Payment amount must be a number greater than zero');
  }
  if (!PAYMENT_METHODS.includes(method)) {
    throw new Error(`method must be one of ${PAYMENT_METHODS.join(', ')}`);
  }

  const run = async (session) => {
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      const err = new Error('Invoice not found');
      err.status = 404;
      throw err;
    }

    const alreadyPaid = await totalPaidFor(invoiceId, session);
    const outstanding = round2(invoice.finalAmount - alreadyPaid);

    if (!allowOverpayment && value > outstanding + 0.01) {
      const err = new Error(
        `Payment cannot exceed the outstanding balance of ${outstanding.toFixed(2)}`
      );
      err.status = 400;
      err.outstanding = outstanding;
      throw err;
    }

    const [payment] = await Payment.create(
      [
        {
          invoiceId: invoice._id,
          customerId: invoice.customerId,
          amount: value,
          method,
          date: date ? new Date(date) : new Date(),
          reference: reference || '',
          notes: notes || '',
          source,
          status: 'ACTIVE',
          createdBy: userId || undefined,
        },
      ],
      { session }
    );

    const updatedInvoice = await recomputeInvoiceFinancials(invoice._id, session);

    await AuditLog.create(
      [
        {
          entity: 'Payment',
          entityId: payment._id,
          field: 'amount',
          oldValue: null,
          newValue: value,
          userId: userId || undefined,
          reason: `Payment recorded against invoice ${invoice.invoiceNumber}`,
        },
      ],
      { session }
    );

    return { payment, invoice: updatedInvoice, previousBalance: alreadyPaid, outstandingBefore: outstanding };
  };

  let result;
  if (externalSession) {
    result = await run(externalSession);
  } else {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        result = await run(session);
      });
    } finally {
      await session.endSession();
    }
  }

  // Reaching full payment can complete an already-delivered order. Kept
  // outside the transaction — same reasoning as the sales checkout flow: a
  // lifecycle hiccup must never roll back a payment that was actually recorded.
  //
  // Skipped entirely when called with an external session (e.g. from
  // salesController.checkout, which calls recordPayment from inside its OWN
  // transaction): that transaction is still open and could still abort, so
  // triggering a non-transactional Order write here could commit an order
  // promotion for a payment that gets rolled back a moment later. The caller
  // that owns the outer transaction is responsible for running this itself
  // once its own transaction has actually committed.
  if (!externalSession && result.invoice.paymentStatus === 'paid') {
    try {
      await applySaleToOrders({
        productIds: (result.invoice.items || []).map((i) => i.productId).filter(Boolean),
        saleOrderId: result.invoice.orderId,
        isFullyPaid: true,
      });
    } catch {
      // Non-fatal: the payment is recorded regardless of downstream order status.
    }
  }

  return result;
}

/**
 * Reverses (voids) a payment. The row is never deleted — it is flagged
 * REVERSED so the original transaction stays visible in the audit trail —
 * and the invoice's derived fields are recalculated to exclude it.
 */
async function reversePayment({ paymentId, reason, userId }) {
  if (!reason || !String(reason).trim()) {
    const err = new Error('A reason is required to reverse a payment');
    err.status = 400;
    throw err;
  }

  const session = await mongoose.startSession();
  let payment;
  let invoice;
  try {
    await session.withTransaction(async () => {
      payment = await Payment.findById(paymentId).session(session);
      if (!payment) {
        const err = new Error('Payment not found');
        err.status = 404;
        throw err;
      }
      if (payment.status === 'REVERSED') {
        const err = new Error('This payment has already been reversed');
        err.status = 400;
        throw err;
      }

      const previousAmount = payment.amount;
      payment.status = 'REVERSED';
      payment.reversal = { reason: String(reason).trim(), reversedBy: userId || undefined, reversedAt: new Date() };
      await payment.save({ session });

      invoice = await recomputeInvoiceFinancials(payment.invoiceId, session);

      await AuditLog.create(
        [
          {
            entity: 'Payment',
            entityId: payment._id,
            field: 'status',
            oldValue: 'ACTIVE',
            newValue: 'REVERSED',
            userId: userId || undefined,
            reason: `${String(reason).trim()} (was ${previousAmount})`,
          },
        ],
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  return { payment, invoice };
}

/** Non-financial correction only — amount/method changes must go through reverse + a new payment, to keep the ledger honest. */
async function updatePaymentDetails({ paymentId, reference, notes, userId }) {
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    const err = new Error('Payment not found');
    err.status = 404;
    throw err;
  }
  if (payment.status === 'REVERSED') {
    const err = new Error('Cannot edit a reversed payment');
    err.status = 400;
    throw err;
  }

  const changes = {};
  if (reference !== undefined && reference !== payment.reference) changes.reference = [payment.reference, reference];
  if (notes !== undefined && notes !== payment.notes) changes.notes = [payment.notes, notes];

  if (reference !== undefined) payment.reference = reference;
  if (notes !== undefined) payment.notes = notes;
  await payment.save();

  for (const [field, [oldValue, newValue]] of Object.entries(changes)) {
    await AuditLog.create({
      entity: 'Payment',
      entityId: payment._id,
      field,
      oldValue,
      newValue,
      userId: userId || undefined,
      reason: 'Payment details corrected',
    });
  }

  return payment;
}

async function listInvoicePayments(invoiceId) {
  return Payment.find({ invoiceId }).sort({ date: 1, createdAt: 1 }).populate('createdBy', 'username role');
}

module.exports = {
  PAYMENT_METHODS,
  totalPaidFor,
  deriveStatus,
  recomputeInvoiceFinancials,
  recordPayment,
  reversePayment,
  updatePaymentDetails,
  listInvoicePayments,
};
