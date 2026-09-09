const asyncHandler = require('express-async-handler');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const FinancialTransaction = require('../models/FinancialTransaction');
const { computeInvoiceTotals, buildInvoiceLineFromOrderItem, round2 } = require('../services/pricingService');
const { renderInvoicePdf } = require('../services/invoicePdfRenderer');
const { applySaleToOrders } = require('../services/orderLifecycleService');
const { recordPayment, totalPaidFor } = require('../services/paymentService');
const { getInvoicePayments, addPayment, getInvoiceOutstanding } = require('./paymentController');

async function nextInvoiceNumber() {
  const count = await Invoice.countDocuments();
  const year = new Date().getFullYear();
  return `INV-${year}-${String(count + 1).padStart(5, '0')}`;
}

const createInvoice = asyncHandler(async (req, res) => {
  const { orderId, discountPercentage, paymentMethod, notes, oldGoldExchange } = req.body;
  const order = await Order.findById(orderId).populate('customerId');
  if (!order) {
    res.status(404);
    throw new Error('Order not found');
  }

  const items = order.items.map(buildInvoiceLineFromOrderItem);

  const discPct = discountPercentage || 0;
  const { subtotal, taxAmount } = computeInvoiceTotals(order.items, 0);
  const discount = order.discount || round2(subtotal * (discPct / 100));
  const finalAmount = round2(subtotal + taxAmount - discount);

  const hasOldGold =
    oldGoldExchange && (oldGoldExchange.weight || oldGoldExchange.rate || oldGoldExchange.amount);

  const invoice = await Invoice.create({
    invoiceNumber: await nextInvoiceNumber(),
    orderId: order._id,
    customerId: order.customerId._id,
    items,
    subtotal,
    discount,
    discountPercentage: discPct,
    taxAmount,
    finalAmount,
    paymentMethod: paymentMethod || 'cash',
    paymentStatus: 'pending',
    notes,
    oldGoldExchange: hasOldGold
      ? {
          date: oldGoldExchange.date,
          weight: oldGoldExchange.weight,
          rate: oldGoldExchange.rate,
          amount: oldGoldExchange.amount,
        }
      : undefined,
  });

  await FinancialTransaction.create({
    type: 'sale',
    amount: finalAmount,
    category: 'jewelry-sale',
    description: `Invoice ${invoice.invoiceNumber}`,
    relatedInvoiceId: invoice._id,
    relatedOrderId: order._id,
    paymentMethod: invoice.paymentMethod,
  });

  // This order may already carry deposits collected before the piece was
  // ready (Order.advancePayments — a token/advance paid in installments).
  // Each one is carried over as its own Payment row rather than folded into
  // a single opening balance, so the original date/method/reference of every
  // deposit the customer actually made stays visible in the invoice's
  // payment history and the customer's ledger.
  const advances = order.advancePayments || [];
  for (const advance of advances) {
    try {
      await recordPayment({
        invoiceId: invoice._id,
        amount: advance.amount,
        method: advance.method || 'cash',
        date: advance.date,
        reference: advance.reference || '',
        notes: advance.notes ? `Order advance: ${advance.notes}` : 'Advance paid before invoicing',
        source: 'order-advance',
        userId: (advance.recordedBy || req.user) && (advance.recordedBy || (req.user && req.user._id)),
        // A carried-over deposit is a historical fact, not a new transaction
        // to validate against an outstanding balance that didn't exist yet
        // when the deposit was actually collected.
        allowOverpayment: true,
      });
    } catch (err) {
      // Never let a malformed historical advance block invoice creation —
      // the invoice itself is the important artifact here.
      console.error(`[invoices] failed to carry over order advance for ${invoice.invoiceNumber}:`, err.message);
    }
  }

  const finalInvoice = advances.length ? await Invoice.findById(invoice._id) : invoice;
  res.status(201).json(finalInvoice);
});

const listInvoices = asyncHandler(async (req, res) => {
  const invoices = await Invoice.find().populate('customerId', 'name phone').sort({ invoiceDate: -1 });
  res.json(invoices);
});

const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).populate('customerId').populate('orderId');
  if (!invoice) {
    res.status(404);
    throw new Error('Invoice not found');
  }
  const amountPaid = await totalPaidFor(invoice._id);
  const payload = invoice.toObject();
  payload.outstanding = round2(invoice.finalAmount - amountPaid);
  res.json(payload);
});

const generatePdf = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).populate('customerId');
  if (!invoice) {
    res.status(404);
    throw new Error('Invoice not found');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${invoice.invoiceNumber}.pdf`);

  renderInvoicePdf(invoice, res);
});

/**
 * PUT /api/invoices/:id/payment-status — retained for backward compatibility,
 * but payment status is now strictly derived from the Payment ledger and can
 * no longer be set directly (see paymentService.recomputeInvoiceFinancials).
 * Record or reverse a payment instead; this endpoint just reports the
 * current, ledger-derived status so an old caller still gets a valid response.
 */
const updatePaymentStatus = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) {
    res.status(404);
    throw new Error('Invoice not found');
  }

  if (req.body && req.body.paymentStatus && req.body.paymentStatus !== invoice.paymentStatus) {
    res.status(400);
    throw new Error(
      'Payment status is derived from payment records and cannot be set directly. ' +
        'Use POST /api/invoices/:id/payments to record a payment, or POST /api/payments/:id/reverse to void one.'
    );
  }

  // Idempotent no-op path (status unchanged, or no status supplied): still
  // useful as a "did this ever settle" completion trigger for legacy callers.
  if (invoice.paymentStatus === 'paid') {
    await applySaleToOrders({
      productIds: (invoice.items || []).map((i) => i.productId).filter(Boolean),
      saleOrderId: invoice.orderId,
      isFullyPaid: true,
    });
  }

  res.json(invoice);
});

module.exports = {
  createInvoice,
  listInvoices,
  getInvoice,
  generatePdf,
  updatePaymentStatus,
  getInvoicePayments,
  addPayment,
  getInvoiceOutstanding,
};
