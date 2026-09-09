const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Invoice = require('../models/Invoice');
const StockTransaction = require('../models/StockTransaction');
const FinancialTransaction = require('../models/FinancialTransaction');
const AuditLog = require('../models/AuditLog');
const { round2 } = require('../services/pricingService');
const { calculateSale } = require('../services/saleCalculationService');
const { applySaleToOrders } = require('../services/orderLifecycleService');
const { recordPayment } = require('../services/paymentService');
const { userHasPermission, PERMISSIONS } = require('../middleware/permissions');
const { config: salesPolicy } = require('../config/salesPolicy');

const PAYMENT_METHODS = ['cash', 'card', 'upi', 'cheque', 'bank-transfer', 'other'];
const COMM_PREFS = ['sms', 'email', 'whatsapp'];

async function nextInvoiceNumber(session) {
  const count = await Invoice.countDocuments().session(session);
  const year = new Date().getFullYear();
  return `INV-${year}-${String(count + 1).padStart(5, '0')}`;
}

/** Maps one priced line from saleCalculationService onto an Order item document. */
function toOrderItem(line) {
  return {
    productId: line.productId,
    name: line.name,
    metalType: line.metalType,
    purity: line.purity,
    weightGrams: line.weightGrams,
    quantity: line.quantity,
    spotPrice: line.productValue,
    markup: line.makingChargeAmount,
    laborCost: 0,
    tax: line.tax,
    finalPrice: line.finalPrice,
    discount: line.discount,
    hsnCode: line.hsnCode,
    grossWeight: line.grossWeight,
    netWeight: line.netWeight,
    ratePerGram: line.ratePerGram,
    currentValueAtSale: line.currentValue,
    defaultMakingChargeType: line.defaultMakingChargeType,
    defaultMakingChargeValue: line.defaultMakingChargeValue,
    saleMakingChargeType: line.saleMakingChargeType,
    saleMakingChargeValue: line.saleMakingChargeValue,
  };
}

/** Maps one Order item (built above) onto an Invoice item — same snapshot fields, print-layout shape. */
function toInvoiceItem(orderItem) {
  return {
    productId: orderItem.productId,
    name: orderItem.name,
    quantity: orderItem.quantity,
    unitPrice: round2(orderItem.finalPrice / orderItem.quantity),
    totalPrice: orderItem.finalPrice,
    hsnCode: orderItem.hsnCode || '',
    purity: orderItem.purity,
    grossWeight: orderItem.grossWeight,
    netWeight: orderItem.netWeight,
    ratePerGram: orderItem.ratePerGram,
    labourCharge: orderItem.markup,
    currentValueAtSale: orderItem.currentValueAtSale,
    defaultMakingChargeType: orderItem.defaultMakingChargeType,
    defaultMakingChargeValue: orderItem.defaultMakingChargeValue,
    saleMakingChargeType: orderItem.saleMakingChargeType,
    saleMakingChargeValue: orderItem.saleMakingChargeValue,
  };
}

/**
 * POST /api/sales/calculate
 *
 * The Sales module's live pricing preview: prices every line (current value
 * at the product's own default making charge, and the sale price at whatever
 * making charge is being applied), applies the chosen billing type, and
 * reports a structured below-current-value warning per line. Read-only — no
 * stock, order, invoice or payment is touched. Checkout below calls this
 * exact same function for its own server-side recalculation, so a preview
 * can never show a number checkout would then charge differently.
 */
const calculateSalePreview = asyncHandler(async (req, res) => {
  const { items, billingType, customerId, discount } = req.body;

  let customerState;
  let customer = null;
  if (customerId) {
    customer = await Customer.findById(customerId);
    if (!customer) {
      res.status(404);
      throw new Error('Customer not found');
    }
    customerState = customer.state;
  }

  const canAdjustMakingCharge = userHasPermission(req.user, PERMISSIONS.ADJUST_MAKING_CHARGES);

  try {
    const result = await calculateSale({
      items,
      billingType,
      customerState,
      canAdjustMakingCharge,
      orderDiscount: discount,
    });
    res.json({
      ...result,
      canAdjustMakingCharge,
      customerGstin: customer ? customer.gstin || '' : '',
    });
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
});

/**
 * POST /api/sales/checkout
 *
 * Atomic "Sales Journey" checkout: recalculates the sale server-side (never
 * trusting a frontend-supplied price), validates stock, creates the Order,
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
    billingType,
    billingAddress,
    communicationPreferences,
    payment,
    notes,
    oldGoldExchange,
    belowValueApproval,
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

  const canAdjustMakingCharge = userHasPermission(req.user, PERMISSIONS.ADJUST_MAKING_CHARGES);
  const canApproveBelowValue = userHasPermission(req.user, PERMISSIONS.APPROVE_BELOW_VALUE_SALE);

  // ---- server-side recalculation: the ONLY prices this endpoint trusts ----
  const customerForCalc = await Customer.findById(customerId);
  if (!customerForCalc) {
    res.status(404);
    throw new Error('Customer not found');
  }

  let calculated;
  try {
    calculated = await calculateSale({
      items,
      billingType,
      customerState: customerForCalc.state,
      canAdjustMakingCharge,
      orderDiscount,
    });
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }

  // ---- below-current-value gate ----
  // A confirmation step by default (ALLOW_BELOW_CURRENT_PRICE_SALE=true): any
  // salesperson may continue once they've explicitly acknowledged it. When
  // that flag is false, only a user holding APPROVE_BELOW_VALUE_SALE can.
  // One acknowledgement covers the whole sale (the frontend shows every
  // flagged line, per item 13) rather than a separate approval per line.
  if (calculated.warnings.length > 0) {
    const approvalRequired = !salesPolicy.allowBelowCurrentPriceSale;
    if (approvalRequired && !canApproveBelowValue) {
      res.status(403);
      const err = new Error('This sale includes items below their current value and requires manager approval');
      err.warnings = calculated.warnings;
      err.requiresApproval = true;
      throw err;
    }
    if (!belowValueApproval || belowValueApproval.approved !== true) {
      res.status(409);
      const err = new Error('One or more items are priced below their current value — confirmation required');
      err.warnings = calculated.warnings;
      err.requiresApproval = approvalRequired;
      throw err;
    }
    if (approvalRequired && !String(belowValueApproval.reason || '').trim()) {
      res.status(400);
      throw new Error('A reason is required to approve a below-current-value sale');
    }
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

      // Stock check + decrement, keyed to the SAME lines calculateSale already
      // priced above — no re-pricing here, just inventory movement.
      const stockTxnIds = [];
      const orderItems = [];
      for (const line of calculated.lines) {
        const product = await Product.findById(line.productId).session(session);
        if (!product) {
          res.status(404);
          throw new Error(`Product not found: ${line.productId}`);
        }
        if (product.quantity < line.quantity) {
          res.status(400);
          throw new Error(
            `Insufficient stock for ${product.name} (have ${product.quantity}, need ${line.quantity})`
          );
        }

        product.quantity -= line.quantity;
        await product.save({ session });

        const [stockTxn] = await StockTransaction.create(
          [
            {
              productId: product._id,
              type: 'sale',
              quantity: -line.quantity,
              costPerUnit: round2(line.finalPrice / line.quantity),
              notes: 'Sales checkout (order pending)',
              performedBy: req.user && req.user._id,
            },
          ],
          { session }
        );
        stockTxnIds.push(stockTxn._id);
        orderItems.push(toOrderItem(line));
      }

      const [createdOrder] = await Order.create(
        [
          {
            customerId,
            items: orderItems,
            discount: orderDiscount,
            notes,
            totalAmount: calculated.grandTotal,
            billingType: calculated.billingType,
            isInterState: calculated.isInterState,
            cgstAmount: calculated.cgstAmount,
            sgstAmount: calculated.sgstAmount,
            igstAmount: calculated.igstAmount,
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

      customer.purchases.push({ orderId: order._id, amount: calculated.grandTotal, date: order.orderDate });
      customer.totalPurchases += calculated.grandTotal;
      customer.loyaltyPoints += Math.floor(calculated.grandTotal / 1000);
      await customer.save({ session });

      const effectiveBillingAddress = billingAddress || customer.address;
      const invoiceNotesParts = [];
      if (notes) invoiceNotesParts.push(notes);
      if (effectiveBillingAddress) invoiceNotesParts.push(`Billing address: ${effectiveBillingAddress}`);

      const invoiceItems = orderItems.map(toInvoiceItem);
      const hasOldGold =
        oldGoldExchange && (oldGoldExchange.weight || oldGoldExchange.rate || oldGoldExchange.amount);

      const [createdInvoice] = await Invoice.create(
        [
          {
            invoiceNumber: await nextInvoiceNumber(session),
            orderId: order._id,
            customerId,
            items: invoiceItems,
            subtotal: calculated.taxableAmount,
            discount: orderDiscount,
            discountPercentage: 0,
            taxAmount: calculated.taxAmount,
            finalAmount: calculated.grandTotal,
            paymentMethod: payment.method,
            paymentStatus: 'pending',
            amountPaid: 0,
            billingType: calculated.billingType,
            customerGstin: customer.gstin || '',
            shopGstin: calculated.shopGstin,
            isInterState: calculated.isInterState,
            cgstAmount: calculated.cgstAmount,
            sgstAmount: calculated.sgstAmount,
            igstAmount: calculated.igstAmount,
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
            amount: calculated.grandTotal,
            category: 'jewelry-sale',
            description: `Invoice ${invoice.invoiceNumber}`,
            relatedInvoiceId: invoice._id,
            relatedOrderId: order._id,
            paymentMethod: payment.method,
          },
        ],
        { session }
      );

      // ---- audit trail: making-charge overrides and below-value approval ----
      const auditEntries = [];
      for (const line of calculated.lines) {
        if (line.makingChargeAdjusted) {
          auditEntries.push({
            entity: 'Sale',
            entityId: order._id,
            field: `makingCharge:${line.productId}`,
            oldValue: { type: line.defaultMakingChargeType, value: line.defaultMakingChargeValue },
            newValue: { type: line.saleMakingChargeType, value: line.saleMakingChargeValue },
            userId: req.user && req.user._id,
            reason: 'Making charge adjusted at sale',
          });
        }
      }
      if (calculated.warnings.length > 0) {
        auditEntries.push({
          entity: 'Sale',
          entityId: order._id,
          field: 'belowCurrentValueApproval',
          oldValue: null,
          newValue: {
            approved: true,
            reason: belowValueApproval && belowValueApproval.reason ? String(belowValueApproval.reason).trim() : '',
            items: calculated.warnings.map((w) => ({
              productId: w.productId,
              currentValue: w.currentValue,
              sellingValue: w.sellingValue,
              difference: w.difference,
            })),
          },
          userId: req.user && req.user._id,
          reason:
            (belowValueApproval && belowValueApproval.reason && String(belowValueApproval.reason).trim()) ||
            'Sale below current value confirmed',
        });
      }
      if (auditEntries.length > 0) {
        await AuditLog.create(auditEntries, { session });
      }

      // Whatever the customer paid at the register becomes the invoice's
      // first ledger entry — recordPayment is the one place that derives
      // amountPaid/paymentStatus, so checkout never duplicates that logic.
      if (amountPaid > 0) {
        try {
          const paymentResult = await recordPayment({
            invoiceId: invoice._id,
            amount: amountPaid,
            method: payment.method,
            reference: payment.reference || '',
            notes: 'Recorded at checkout',
            userId: req.user && req.user._id,
            session,
          });
          invoice = paymentResult.invoice;
        } catch (err) {
          res.status(err.status || 400);
          throw err;
        }
      }
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
      productIds: calculated.lines.map((l) => l.productId).filter(Boolean),
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

/**
 * GET /api/sales/policy
 * The business-configured defaults the Billing step needs before any
 * calculation has run — which billing type to preselect, and whether a
 * below-value sale can be confirmed by anyone or needs manager approval.
 */
const getSalesPolicy = asyncHandler(async (req, res) => {
  res.json({
    defaultBillingType: salesPolicy.defaultBillingType,
    allowBelowCurrentPriceSale: salesPolicy.allowBelowCurrentPriceSale,
    canAdjustMakingCharge: userHasPermission(req.user, PERMISSIONS.ADJUST_MAKING_CHARGES),
    canApproveBelowValueSale: userHasPermission(req.user, PERMISSIONS.APPROVE_BELOW_VALUE_SALE),
  });
});

module.exports = { checkout, calculateSalePreview, getSalesPolicy };
