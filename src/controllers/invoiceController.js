const asyncHandler = require('express-async-handler');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const FinancialTransaction = require('../models/FinancialTransaction');
const { computeInvoiceTotals, buildInvoiceLineFromOrderItem, round2 } = require('../services/pricingService');
const { renderInvoicePdf } = require('../services/invoicePdfRenderer');
const { applySaleToOrders } = require('../services/orderLifecycleService');

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

  res.status(201).json(invoice);
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
  res.json(invoice);
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

const updatePaymentStatus = asyncHandler(async (req, res) => {
  const { paymentStatus } = req.body;
  const valid = ['pending', 'paid', 'partial'];
  if (!valid.includes(paymentStatus)) {
    res.status(400);
    throw new Error(`paymentStatus must be one of ${valid.join(', ')}`);
  }
  const invoice = await Invoice.findByIdAndUpdate(req.params.id, { paymentStatus }, { new: true });
  if (!invoice) {
    res.status(404);
    throw new Error('Invoice not found');
  }

  // Settling the bill completes an order that's already been handed over —
  // including any custom order fulfilled by the items on this invoice.
  if (paymentStatus === 'paid') {
    await applySaleToOrders({
      productIds: (invoice.items || []).map((i) => i.productId).filter(Boolean),
      saleOrderId: invoice.orderId,
      isFullyPaid: true,
    });
  }

  res.json(invoice);
});

module.exports = { createInvoice, listInvoices, getInvoice, generatePdf, updatePaymentStatus };
