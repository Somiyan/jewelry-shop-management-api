const asyncHandler = require('express-async-handler');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const {
  PAYMENT_METHODS,
  recordPayment,
  reversePayment,
  updatePaymentDetails,
  listInvoicePayments,
  totalPaidFor,
} = require('../services/paymentService');
const { round2 } = require('../services/pricingService');

/**
 * GET /api/invoices/:id/payments
 * Full payment history for one invoice, oldest first (matches how a receipt
 * ledger reads top-to-bottom).
 */
const getInvoicePayments = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) {
    res.status(404);
    throw new Error('Invoice not found');
  }
  const payments = await listInvoicePayments(invoice._id);
  res.json(payments);
});

/**
 * POST /api/invoices/:id/payments
 * Records one payment. Validates amount > 0 and <= outstanding (unless the
 * caller has been granted overpayment authority — see below), then derives
 * and persists the invoice's paid amount and status from the ledger.
 */
const addPayment = asyncHandler(async (req, res) => {
  const { amount, method, date, reference, notes, allowOverpayment } = req.body;

  if (amount == null) {
    res.status(400);
    throw new Error('amount is required');
  }
  if (method !== undefined && !PAYMENT_METHODS.includes(method)) {
    res.status(400);
    throw new Error(`method must be one of ${PAYMENT_METHODS.join(', ')}`);
  }

  try {
    const result = await recordPayment({
      invoiceId: req.params.id,
      amount,
      method,
      date,
      reference,
      notes,
      userId: req.user && req.user._id,
      // Overpayment is a deliberate exception, not a default — only an admin
      // may explicitly authorize it per invoice, matching "unless explicitly
      // authorized" in the module's validation rule.
      allowOverpayment: Boolean(allowOverpayment) && req.user && req.user.role === 'admin',
    });

    res.status(201).json({
      payment: result.payment,
      invoice: result.invoice,
      receipt: {
        previousBalance: result.outstandingBefore,
        paymentReceived: result.payment.amount,
        remainingBalance: round2(result.outstandingBefore - result.payment.amount),
      },
    });
  } catch (err) {
    res.status(err.status || 500);
    throw err;
  }
});

/**
 * PUT /api/payments/:id
 * Non-financial correction only (reference/notes). Amount and method are
 * immutable once recorded — a mistaken amount is corrected by reversing the
 * payment and recording a new one, which keeps the ledger's history honest.
 */
const editPayment = asyncHandler(async (req, res) => {
  const { reference, notes, amount, method } = req.body;
  if (amount !== undefined || method !== undefined) {
    res.status(400);
    throw new Error('amount and method cannot be edited — reverse this payment and record a new one instead');
  }
  try {
    const payment = await updatePaymentDetails({
      paymentId: req.params.id,
      reference,
      notes,
      userId: req.user && req.user._id,
    });
    res.json(payment);
  } catch (err) {
    res.status(err.status || 500);
    throw err;
  }
});

/**
 * POST /api/payments/:id/reverse
 * Voids a payment (never deletes it) and recalculates the invoice.
 */
const reversePaymentHandler = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  try {
    const result = await reversePayment({ paymentId: req.params.id, reason, userId: req.user && req.user._id });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500);
    throw err;
  }
});

/** GET /api/invoices/:id/outstanding — quick balance check without the full payment list. */
const getInvoiceOutstanding = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) {
    res.status(404);
    throw new Error('Invoice not found');
  }
  const amountPaid = await totalPaidFor(invoice._id);
  res.json({
    finalAmount: invoice.finalAmount,
    amountPaid,
    outstanding: round2(invoice.finalAmount - amountPaid),
    paymentStatus: invoice.paymentStatus,
  });
});

/**
 * GET /api/payments/:id/receipt
 * Everything a printable/downloadable receipt needs: what the balance was
 * before this payment, what was received, and what remains. Rendering (print
 * dialog, PDF, share) is a frontend concern — this endpoint is the single
 * source of truth for the numbers on it.
 */
const getReceipt = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id)
    .populate('invoiceId')
    .populate('customerId', 'name phone email')
    .populate('createdBy', 'username');
  if (!payment) {
    res.status(404);
    throw new Error('Payment not found');
  }

  const invoice = payment.invoiceId;
  // Balance immediately after this payment, from payments strictly before it
  // in the ledger (by recorded date, tie-broken by insertion order) — so a
  // receipt printed later still reflects what the customer saw at the counter.
  const priorPayments = await Payment.find({
    invoiceId: invoice._id,
    status: 'ACTIVE',
    $or: [{ date: { $lt: payment.date } }, { date: payment.date, createdAt: { $lt: payment.createdAt } }],
  });
  const paidBefore = round2(priorPayments.reduce((sum, p) => sum + p.amount, 0));

  res.json({
    receiptNumber: `RCPT-${String(payment._id).slice(-8).toUpperCase()}`,
    customer: payment.customerId,
    invoiceNumber: invoice ? invoice.invoiceNumber : null,
    paymentDate: payment.date,
    amountReceived: payment.amount,
    paymentMethod: payment.method,
    reference: payment.reference,
    notes: payment.notes,
    recordedBy: payment.createdBy ? payment.createdBy.username : null,
    previousBalance: invoice ? round2(invoice.finalAmount - paidBefore) : null,
    paymentReceived: payment.amount,
    remainingBalance: invoice ? round2(invoice.finalAmount - paidBefore - payment.amount) : null,
    voided: payment.status === 'REVERSED',
  });
});

module.exports = {
  getInvoicePayments,
  addPayment,
  editPayment,
  reversePaymentHandler,
  getInvoiceOutstanding,
  getReceipt,
};
