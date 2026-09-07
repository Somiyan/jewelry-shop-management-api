const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const StockTransaction = require('../models/StockTransaction');
const PricingRule = require('../models/PricingRule');
const {
  buildLineItem,
  buildCustomOrderItem,
  computePricingBreakdown,
  getCurrentMetalRate,
  round2,
} = require('../services/pricingService');
const {
  createProductFromOrderItem,
  promoteOrderIfAllItemsReady,
  promoteIfDeliveredAndPaid,
} = require('../services/orderLifecycleService');

// Confirmation threshold for the custom/made-to-order "mark ready" recalculation —
// if the recomputed final price differs from the original estimate by more than
// this many percent, the salesperson must explicitly confirm before it's saved.
// A constant is the right amount of engineering here; no Settings/config UI needed.
const PRICE_VARIANCE_THRESHOLD_PERCENT = 10;

/**
 * Adds derived payment fields to an order response — never stored, always
 * computed from the advancePayments ledger (a customer may pay a token in
 * several installments, so there is no single "the advance" to read).
 */
function withPaymentSummary(orderDoc) {
  const order = orderDoc.toObject ? orderDoc.toObject() : orderDoc;
  const advanceTotal = round2((order.advancePayments || []).reduce((sum, p) => sum + (p.amount || 0), 0));
  const balanceDue = round2((order.totalAmount || 0) - advanceTotal);
  let paymentStatus = 'unpaid';
  if (advanceTotal > 0 && balanceDue > 0) paymentStatus = 'partial';
  else if (advanceTotal > 0 && balanceDue <= 0) paymentStatus = 'paid';
  return { ...order, advanceTotal, balanceDue, paymentStatus };
}

// ---------------------------------------------------------------------------
// EXISTING "sell from stock" flow — untouched.
// ---------------------------------------------------------------------------

async function buildOrderItem(rawItem) {
  const product = await Product.findById(rawItem.productId);
  if (!product) throw new Error(`Product not found: ${rawItem.productId}`);
  const quantity = rawItem.quantity || 1;
  if (product.quantity < quantity) {
    throw new Error(`Insufficient stock for ${product.name} (have ${product.quantity}, need ${quantity})`);
  }
  const item = await buildLineItem(product, quantity, rawItem.discount || 0);
  return {
    item,
    product,
    quantity,
  };
}

// ---------------------------------------------------------------------------
// NEW "custom / made-to-order" flow — coexists with the above on the same
// Order document. No Product lookup, no stock movement, no StockTransaction.
// ---------------------------------------------------------------------------

/**
 * Builds one custom-order line item from raw request input. Looks up the
 * live PreciousMetalRate + PricingRule for the item's metalType (same pattern
 * getPriceBreakdownForProduct uses for stock-linked products), applies an
 * optional admin/manager-only goldRateOverride, and prices via buildCustomOrderItem.
 */
async function buildCustomItem(rawItem, req, res) {
  const { itemName, estimatedWeight, purity, metalType } = rawItem;
  const validMetal = ['gold', 'silver'].includes(metalType);
  if (!itemName || !(Number(estimatedWeight) > 0) || !(Number(purity) > 0 && Number(purity) <= 100) || !validMetal) {
    res.status(400);
    throw new Error(
      'Custom order items require itemName, estimatedWeight > 0, purity in (0, 100], and metalType (gold|silver)'
    );
  }

  const [currentRate, pricingRule] = await Promise.all([
    getCurrentMetalRate(metalType),
    PricingRule.findOne({ metalType }),
  ]);
  if (!currentRate) {
    res.status(400);
    throw new Error(`No current metal rate configured for ${metalType}`);
  }
  if (!pricingRule) {
    res.status(400);
    throw new Error(`No pricing rule configured for ${metalType}`);
  }

  // A gold-rate override is an admin/manager privilege only; a staff-submitted
  // override on an otherwise-valid item is silently ignored (live rate used)
  // rather than failing the whole order over a permission mismatch on one field.
  let effectiveRate = currentRate.ratePerGram;
  const isPrivileged = req.user && ['admin', 'manager'].includes(req.user.role);
  if (rawItem.goldRateOverride != null && isPrivileged) {
    effectiveRate = Number(rawItem.goldRateOverride);
  }

  const item = buildCustomOrderItem(rawItem, effectiveRate, pricingRule.taxPercentage || 0);
  return {
    item,
    product: null,
    quantity: item.quantity,
  };
}

const createOrder = asyncHandler(async (req, res) => {
  const { customerId, items, deliveryDate, discount, notes, advance } = req.body;
  if (!customerId || !Array.isArray(items) || items.length === 0) {
    res.status(400);
    throw new Error('customerId and at least one item are required');
  }

  const customer = await Customer.findById(customerId);
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }

  const built = await Promise.all(
    items.map((rawItem) => (rawItem && rawItem.isCustomOrder ? buildCustomItem(rawItem, req, res) : buildOrderItem(rawItem)))
  );

  const hasCustomItem = built.some((b) => b.item.isCustomOrder);

  // Optional first advance/token payment against the order — validated at the
  // boundary. Only admin/manager may take an advance larger than the order
  // total (mirrors the staff-vs-admin/manager gate already used elsewhere,
  // e.g. productController.updateProduct's RESTRICTED_UPDATE_FIELDS check).
  // Recorded as the first entry in the advancePayments ledger — a customer may
  // pay further installments later via POST /:id/advance-payments.
  let advancePayload;
  if (advance !== undefined && advance !== null) {
    const amount = Number(advance.amount);
    if (Number.isNaN(amount) || amount < 0) {
      res.status(400);
      throw new Error('advance.amount must be a number >= 0');
    }
    advancePayload = {
      amount,
      method: advance.method,
      date: advance.date,
      reference: advance.reference || '',
      notes: advance.notes || '',
      recordedBy: req.user && req.user._id,
    };
  }

  // Unchanged formula — already works for a mix of custom and stock-linked
  // items since both produce a finalPrice.
  const totalAmount = built.reduce((sum, b) => sum + b.item.finalPrice, 0) - (discount || 0);

  if (advancePayload && advancePayload.amount > totalAmount) {
    const isPrivileged = req.user && ['admin', 'manager'].includes(req.user.role);
    if (!isPrivileged) {
      res.status(400);
      throw new Error('advance.amount cannot exceed the order totalAmount');
    }
  }

  const orderPayload = {
    customerId,
    items: built.map((b) => b.item),
    deliveryDate,
    discount: discount || 0,
    notes,
    totalAmount,
    advancePayments: advancePayload ? [advancePayload] : [],
  };
  // Per the brief: an order that includes a custom/made-to-order item or takes
  // an advance is treated as confirmed once saved — leave the schema default
  // ('pending') untouched for the plain sell-from-stock flow.
  if (hasCustomItem || advancePayload) {
    orderPayload.status = 'confirmed';
  }

  const order = await Order.create(orderPayload);

  for (const b of built) {
    if (b.item.isCustomOrder) continue; // no stock exists yet for a custom/made-to-order item
    b.product.quantity -= b.quantity;
    await b.product.save();
    await StockTransaction.create({
      productId: b.product._id,
      type: 'sale',
      quantity: -b.quantity,
      costPerUnit: b.item.finalPrice / b.quantity,
      notes: `Order ${order._id}`,
      performedBy: req.user && req.user._id,
    });
  }

  customer.purchases.push({ orderId: order._id, amount: totalAmount, date: order.orderDate });
  customer.totalPurchases += totalAmount;
  customer.loyaltyPoints += Math.floor(totalAmount / 1000);
  await customer.save();

  res.status(201).json(withPaymentSummary(order));
});

const listOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find().populate('customerId', 'name phone').sort({ orderDate: -1 });
  res.json(orders.map(withPaymentSummary));
});

const getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).populate('customerId');
  if (!order) {
    res.status(404);
    throw new Error('Order not found');
  }
  res.json(withPaymentSummary(order));
});

const updateOrder = asyncHandler(async (req, res) => {
  const { deliveryDate, notes, discount } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) {
    res.status(404);
    throw new Error('Order not found');
  }

  if (deliveryDate !== undefined) order.deliveryDate = deliveryDate;
  if (notes !== undefined) order.notes = notes;
  if (discount !== undefined) {
    order.discount = discount;
    const itemsTotal = order.items.reduce((sum, i) => sum + i.finalPrice, 0);
    order.totalAmount = itemsTotal - discount;
  }

  await order.save();
  res.json(withPaymentSummary(order));
});

const updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const valid = [
    'pending',
    'confirmed',
    'processing',
    'ready',
    'delivered',
    'draft',
    'in_manufacturing',
    'completed',
    'cancelled',
  ];
  if (!valid.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of ${valid.join(', ')}`);
  }
  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!order) {
    res.status(404);
    throw new Error('Order not found');
  }
  res.json(withPaymentSummary(order));
});

const listByStatus = asyncHandler(async (req, res) => {
  const orders = await Order.find({ status: req.params.status }).populate('customerId', 'name phone');
  res.json(orders.map(withPaymentSummary));
});

/**
 * POST /api/orders/:id/advance-payments
 *
 * Appends one payment to the order's advance ledger — a customer may pay a
 * token/advance in several installments while a piece is being manufactured,
 * so this is additive, never a single overwritten snapshot. Only admin/manager
 * may push the running total past the order's totalAmount (same precedent as
 * the initial-advance check in createOrder).
 */
const addAdvancePayment = asyncHandler(async (req, res) => {
  const { amount, method, date, reference, notes } = req.body;
  const parsedAmount = Number(amount);
  if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400);
    throw new Error('amount must be a number greater than 0');
  }

  const order = await Order.findById(req.params.id);
  if (!order) {
    res.status(404);
    throw new Error('Order not found');
  }

  const existingTotal = (order.advancePayments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
  const newTotal = existingTotal + parsedAmount;
  if (newTotal > order.totalAmount) {
    const isPrivileged = req.user && ['admin', 'manager'].includes(req.user.role);
    if (!isPrivileged) {
      res.status(400);
      throw new Error(
        `This payment would bring total advance paid (₹${round2(newTotal)}) above the order total (₹${order.totalAmount})`
      );
    }
  }

  order.advancePayments.push({
    amount: parsedAmount,
    method: method || 'cash',
    date: date || new Date(),
    reference: reference || '',
    notes: notes || '',
    recordedBy: req.user && req.user._id,
  });
  // An already-delivered order settles into 'completed' once payment catches up.
  promoteIfDeliveredAndPaid(order);
  await order.save();
  res.status(201).json(withPaymentSummary(order));
});

// ---------------------------------------------------------------------------
// Custom/made-to-order lifecycle: mark ready, then convert to a real Product.
// ---------------------------------------------------------------------------

/**
 * PATCH /api/orders/:id/items/:itemIndex/ready
 *
 * Any authenticated user may call this; changing wastagePercentage/
 * makingChargeType/makingChargeValue/a gold-rate override is admin/manager only.
 * If the recomputed final price varies from the original estimate by more than
 * PRICE_VARIANCE_THRESHOLD_PERCENT, nothing is persisted and the caller must
 * re-call with confirmVariance: true to actually save.
 */
const markItemReady = asyncHandler(async (req, res) => {
  const { id, itemIndex } = req.params;
  const idx = Number(itemIndex);

  const order = await Order.findById(id);
  if (!order) {
    res.status(404);
    throw new Error('Order not found');
  }
  const item = order.items[idx];
  if (!item || !item.isCustomOrder) {
    res.status(404);
    throw new Error('Custom order item not found at that index');
  }
  // Marking an item ready now creates real sellable stock, so a cancelled
  // order must not be able to push inventory in through the back door.
  if (order.status === 'cancelled') {
    res.status(400);
    throw new Error('This order is cancelled — reopen it before marking items ready');
  }

  const {
    finalGrossWeight,
    finalNetWeight,
    finalPurity,
    wastagePercentage,
    makingChargeType,
    makingChargeValue,
    goldRateOverride,
    confirmVariance,
  } = req.body;

  if (
    !(Number(finalGrossWeight) > 0) ||
    !(Number(finalNetWeight) > 0) ||
    !(Number(finalPurity) > 0 && Number(finalPurity) <= 100)
  ) {
    res.status(400);
    throw new Error('finalGrossWeight > 0, finalNetWeight > 0, and finalPurity in (0, 100] are required');
  }
  if (Number(finalNetWeight) > Number(finalGrossWeight)) {
    res.status(400);
    throw new Error('finalNetWeight cannot exceed finalGrossWeight');
  }

  const isPrivileged = req.user && ['admin', 'manager'].includes(req.user.role);
  const restrictedTouched = ['wastagePercentage', 'makingChargeType', 'makingChargeValue', 'goldRateOverride'].filter(
    (f) => req.body[f] !== undefined
  );
  if (restrictedTouched.length > 0 && !isPrivileged) {
    res.status(403);
    throw new Error(
      `Forbidden: only admin/manager can set ${restrictedTouched.join(', ')} when marking a custom item ready`
    );
  }

  // Falls back to the terms actually quoted at order time, not a hardcoded
  // default — omitting these fields must reprice at the agreed making charge,
  // never silently at 0%.
  const effectiveWastage = wastagePercentage !== undefined ? Number(wastagePercentage) : item.wastagePercentage || 0;
  const effectiveMakingType = makingChargeType !== undefined ? makingChargeType : item.makingChargeType || 'percentage';
  const effectiveMakingValue =
    makingChargeValue !== undefined ? Number(makingChargeValue) : item.makingChargeValue || 0;

  let effectiveRate;
  if (goldRateOverride != null && isPrivileged) {
    effectiveRate = Number(goldRateOverride);
  } else {
    const currentRate = await getCurrentMetalRate(item.metalType);
    if (!currentRate) {
      res.status(400);
      throw new Error(`No current metal rate configured for ${item.metalType}`);
    }
    effectiveRate = currentRate.ratePerGram;
  }

  const pricingRule = await PricingRule.findOne({ metalType: item.metalType });
  if (!pricingRule) {
    res.status(400);
    throw new Error(`No pricing rule configured for ${item.metalType}`);
  }

  const price = computePricingBreakdown({
    netWeight: Number(finalNetWeight),
    purity: Number(finalPurity),
    wastagePercentage: effectiveWastage,
    makingChargeType: effectiveMakingType,
    makingChargeValue: effectiveMakingValue,
    purchaseMetalRate: effectiveRate,
    currentMetalRate: effectiveRate,
    taxPercentage: pricingRule.taxPercentage || 0,
  });

  const quantity = item.quantity || 1;
  const newFinalPrice = round2(price.finalPrice * quantity);

  const estimatedPrice = item.estimatedPrice || 0;
  const variancePercent = estimatedPrice > 0 ? (Math.abs(newFinalPrice - estimatedPrice) / estimatedPrice) * 100 : 0;

  if (variancePercent > PRICE_VARIANCE_THRESHOLD_PERCENT && confirmVariance !== true) {
    res.status(200).json({
      requiresConfirmation: true,
      estimatedPrice,
      recalculatedFinalPrice: newFinalPrice,
      variancePercent: round2(variancePercent),
    });
    return;
  }

  item.finalGrossWeight = Number(finalGrossWeight);
  item.finalNetWeight = Number(finalNetWeight);
  item.finalPurity = Number(finalPurity);
  item.finalMakingChargeType = effectiveMakingType;
  item.finalMakingChargeValue = effectiveMakingValue;
  item.finalGoldRate = effectiveRate;
  if (wastagePercentage !== undefined) item.wastagePercentage = effectiveWastage;

  item.spotPrice = round2(price.basePrice * quantity);
  item.markup = round2(price.markup * quantity);
  item.laborCost = round2(price.laborCost * quantity);
  item.tax = round2(price.tax * quantity);
  item.finalPrice = newFinalPrice;
  // Legacy field — anything still reading weightGrams sees the corrected value.
  item.weightGrams = Number(finalNetWeight);
  // The finished piece physically exists now, so it becomes sellable stock
  // immediately — otherwise it couldn't be picked in a sale. SKU/barcode/image
  // may be supplied here; the SKU is auto-generated from the category when not.
  // createProductFromOrderItem sets fulfillmentStatus to 'converted'.
  let createdProduct = null;
  if (!item.productId) {
    createdProduct = await createProductFromOrderItem({
      order,
      item,
      sku: req.body.sku,
      barcode: req.body.barcode,
      image: req.body.image,
      userId: req.user && req.user._id,
    });
  } else {
    // Re-recording final specs on an item that already has stock: keep it
    // 'converted'. Dropping back to 'ready' would leave the item claiming it
    // isn't in inventory while still pointing at a product.
    item.fulfillmentStatus = 'converted';
  }

  order.markModified('items');
  order.totalAmount = order.items.reduce((sum, i) => sum + i.finalPrice, 0) - (order.discount || 0);
  promoteOrderIfAllItemsReady(order);

  await order.save();
  res.json({ ...withPaymentSummary(order), createdProduct });
});

/**
 * POST /api/orders/:id/items/:itemIndex/convert-to-product
 *
 * admin/manager only. Marking an item ready now creates its product
 * automatically, so this remains as the explicit path for items that predate
 * that behaviour, or for re-running a conversion with a specific SKU/barcode.
 * Wrapped in a Mongo transaction (same pattern as salesController's atomic
 * checkout) since it touches two collections that must agree.
 */
const convertItemToProduct = asyncHandler(async (req, res) => {
  const { id, itemIndex } = req.params;
  const idx = Number(itemIndex);
  const { sku, barcode, image, quantity } = req.body;

  const order = await Order.findById(id);
  if (!order) {
    res.status(404);
    throw new Error('Order not found');
  }
  const item = order.items[idx];
  if (!item || !item.isCustomOrder) {
    res.status(404);
    throw new Error('Custom order item not found at that index');
  }
  if (item.fulfillmentStatus === 'pending') {
    res.status(400);
    throw new Error('Item must be marked ready before it can be converted to a product');
  }
  if (item.productId) {
    res.status(400);
    throw new Error('Item has already been converted to a product');
  }

  const session = await mongoose.startSession();
  let product;
  try {
    await session.withTransaction(async () => {
      product = await createProductFromOrderItem({
        order,
        item,
        sku,
        barcode,
        image,
        quantity,
        userId: req.user && req.user._id,
        session,
      });
      order.markModified('items');
      promoteOrderIfAllItemsReady(order);
      await order.save({ session });
    });
  } finally {
    await session.endSession();
  }

  res.status(201).json({ order: withPaymentSummary(order), product });
});

module.exports = {
  createOrder,
  listOrders,
  getOrder,
  updateOrder,
  updateStatus,
  listByStatus,
  markItemReady,
  convertItemToProduct,
  addAdvancePayment,
};
