const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Invoice = require('../models/Invoice');
const StockTransaction = require('../models/StockTransaction');
const FinancialTransaction = require('../models/FinancialTransaction');
const { buildLineItem, buildInvoiceLineFromOrderItem, computeInvoiceTotals, round2 } = require('../services/pricingService');
const { applySaleToOrders } = require('../services/orderLifecycleService');

const PAYMENT_METHODS = ['cash', 'card', 'upi', 'cheque', 'bank-transfer', 'other'];
const COMM_PREFS = ['sms', 'email', 'whatsapp'];

async function nextInvoiceNumber(session) {
  const count = await Invoice.countDocuments().session(session);
  const year = new Date().getFullYear();
  return `INV-${year}-${String(count + 1).padStart(5, '0')}`;
}

/**
 * POST /api/sales/checkout
 *
 * Atomic "Sales Journey" checkout: validates stock, creates the Order,
 * decrements stock (with StockTransaction audit records), updates the
 * customer's purchase history/loyalty points, creates the Invoice, and
 * records a FinancialTransaction — all inside a single Mongo transaction.
 * If anything fails partway through, nothing persists.
 */
const checkout = asyncHandler(async (req, res) => {
  const {
    customerId,
    items,
    discount,
    billingAddress,
    communicationPreferences,
    payment,
    notes,
    oldGoldExchange,
  } = req.body;

  // ---- input validation at the API boundary ----
  if (!customerId) {
    res.status(400);
    throw new Error('customerId is required');
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400);
    throw new Error('At least one item is required');
  }
  items.forEach((it, idx) => {
    if (!it || !it.productId) {
      res.status(400);
      throw new Error(`items[${idx}].productId is required`);
    }
    if (!(Number(it.quantity) >= 1)) {
      res.status(400);
      throw new Error(`items[${idx}].quantity must be a number >= 1`);
    }
    if (it.discount != null && Number(it.discount) < 0) {
      res.status(400);
      throw new Error(`items[${idx}].discount must be >= 0`);
    }
  });

  const orderDiscount = discount != null ? Number(discount) : 0;
  if (Number.isNaN(orderDiscount) || orderDiscount < 0) {
    res.status(400);
    throw new Error('discount must be a number >= 0');
  }

  if (!payment || !PAYMENT_METHODS.includes(payment.method)) {
    res.status(400);
    throw new Error(`payment.method must be one of ${PAYMENT_METHODS.join(', ')}`);
  }
  const amountPaid = Number(payment.amountPaid);
  if (Number.isNaN(amountPaid) || amountPaid < 0) {
    res.status(400);
    throw new Error('payment.amountPaid must be a number >= 0');
  }

  let commPrefs = [];
  if (communicationPreferences !== undefined) {
    if (
      !Array.isArray(communicationPreferences) ||
      communicationPreferences.some((p) => !COMM_PREFS.includes(p))
    ) {
      res.status(400);
      throw new Error(`communicationPreferences must be a subset of ${COMM_PREFS.join(', ')}`);
    }
    commPrefs = communicationPreferences;
  }

  const session = await mongoose.startSession();
  let order;
  let invoice;

  try {
    await session.withTransaction(async () => {
      const customer = await Customer.findById(customerId).session(session);
      if (!customer) {
        res.status(404);
        throw new Error('Customer not found');
      }

      // Process items sequentially: check stock against the transaction's current view
      // (which reflects earlier decrements made *within this same loop*, so two lines
      // for the same product can't both pass a stale stock check), build the priced
      // line item, and decrement + audit-log the stock immediately. The order doesn't
      // exist yet at this point, so each StockTransaction is logged with a placeholder
      // note that gets patched with the real order reference once the order is created.
      const built = [];
      const stockTxnIds = [];
      for (const rawItem of items) {
        const product = await Product.findById(rawItem.productId).session(session);
        if (!product) {
          res.status(404);
          throw new Error(`Product not found: ${rawItem.productId}`);
        }
        const quantity = Number(rawItem.quantity);
        if (product.quantity < quantity) {
          res.status(400);
          throw new Error(
            `Insufficient stock for ${product.name} (have ${product.quantity}, need ${quantity})`
          );
        }
        const lineItem = await buildLineItem(product, quantity, rawItem.discount || 0, session);

        product.quantity -= quantity;
        await product.save({ session });

        const [stockTxn] = await StockTransaction.create(
          [
            {
              productId: product._id,
              type: 'sale',
              quantity: -quantity,
              costPerUnit: round2(lineItem.finalPrice / quantity),
              notes: 'Sales checkout (order pending)',
              performedBy: req.user && req.user._id,
            },
          ],
          { session }
        );
        stockTxnIds.push(stockTxn._id);
        built.push({ lineItem });
      }

      const totalAmount = round2(
        built.reduce((sum, b) => sum + b.lineItem.finalPrice, 0) - orderDiscount
      );

      const [createdOrder] = await Order.create(
        [
          {
            customerId,
            items: built.map((b) => b.lineItem),
            discount: orderDiscount,
            notes,
            totalAmount,
          },
        ],
        { session }
      );
      order = createdOrder;

      await StockTransaction.updateMany(
        { _id: { $in: stockTxnIds } },
        { $set: { notes: `Sale ${order._id}` } },
        { session }
      );

      customer.purchases.push({ orderId: order._id, amount: totalAmount, date: order.orderDate });
      customer.totalPurchases += totalAmount;
      customer.loyaltyPoints += Math.floor(totalAmount / 1000);
      await customer.save({ session });

      const { subtotal, taxAmount, discount: invoiceDiscount, finalAmount } = computeInvoiceTotals(
        built.map((b) => b.lineItem),
        orderDiscount
      );

      let paymentStatus = 'pending';
      if (amountPaid >= finalAmount) paymentStatus = 'paid';
      else if (amountPaid > 0) paymentStatus = 'partial';

      const effectiveBillingAddress = billingAddress || customer.address;
      const invoiceNotesParts = [];
      if (notes) invoiceNotesParts.push(notes);
      if (effectiveBillingAddress) invoiceNotesParts.push(`Billing address: ${effectiveBillingAddress}`);

      const invoiceItems = built.map((b) => buildInvoiceLineFromOrderItem(b.lineItem));
      const hasOldGold =
        oldGoldExchange && (oldGoldExchange.weight || oldGoldExchange.rate || oldGoldExchange.amount);

      const [createdInvoice] = await Invoice.create(
        [
          {
            invoiceNumber: await nextInvoiceNumber(session),
            orderId: order._id,
            customerId,
            items: invoiceItems,
            subtotal,
            discount: invoiceDiscount,
            discountPercentage: 0,
            taxAmount,
            finalAmount,
            paymentMethod: payment.method,
            paymentStatus,
            amountPaid,
            notes: invoiceNotesParts.join(' | '),
            oldGoldExchange: hasOldGold
              ? {
                  date: oldGoldExchange.date,
                  weight: oldGoldExchange.weight,
                  rate: oldGoldExchange.rate,
                  amount: oldGoldExchange.amount,
                }
              : undefined,
          },
        ],
        { session }
      );
      invoice = createdInvoice;

      await FinancialTransaction.create(
        [
          {
            type: 'sale',
            amount: finalAmount,
            category: 'jewelry-sale',
            description: `Invoice ${invoice.invoiceNumber}`,
            relatedInvoiceId: invoice._id,
            relatedOrderId: order._id,
            paymentMethod: payment.method,
          },
        ],
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  // Post-sale lifecycle: the goods just changed hands, so the sale's own order
  // is delivered, and any earlier custom/made-to-order order whose manufactured
  // piece was what got sold is delivered too (a custom order is fulfilled on a
  // different order document than the one that recorded the original request).
  // Both settle to 'completed' when the sale was paid in full. Deliberately
  // outside the transaction above: a lifecycle-status hiccup must never roll
  // back a completed sale.
  let lifecycleWarning = null;
  try {
    await applySaleToOrders({
      productIds: (items || []).map((i) => i.productId).filter(Boolean),
      saleOrderId: order._id,
      isFullyPaid: invoice.paymentStatus === 'paid',
    });
  } catch (err) {
    lifecycleWarning = `Sale recorded, but order statuses could not be updated: ${err.message}`;
  }

  const invoicePayload = invoice.toObject();
  invoicePayload.communicationPreferences = commPrefs;

  const freshOrder = await Order.findById(order._id);
  res.status(201).json({ order: freshOrder || order, invoice: invoicePayload, lifecycleWarning });
});

module.exports = { checkout };
