const PreciousMetalRate = require('../models/PreciousMetalRate');
const PricingRule = require('../models/PricingRule');

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Computes the making-charge amount that gets added to the pure-metal value
 * to arrive at the customer-facing selling price.
 *
 *  - percentage mode: makingChargeValue is a PERCENTAGE POINT added on top of
 *    purity, applied against the current metal rate.
 *  - per_gram mode: makingChargeValue is a flat ₹-per-gram rate applied to netWeight.
 */
function computeMakingChargeAmount({ netWeight, makingChargeType, makingChargeValue, currentMetalRate }) {
  if (makingChargeType === 'per_gram') {
    return netWeight * (makingChargeValue || 0);
  }
  // default / 'percentage' mode
  return netWeight * ((makingChargeValue || 0) / 100) * currentMetalRate;
}

/**
 * Pure jewellery pricing calculation. Nothing here is persisted — the selling
 * price and current cost are always derived live from netWeight/purity/wastage/
 * making-charge inputs + the metal's current rate. `purchaseCost`/`purchaseMetalRate`
 * are passed straight through as the frozen values they already are.
 *
 * Wastage affects COST ONLY (purchaseCost/currentCost) — it never appears in the
 * customer-facing selling price. Making charge affects the SELLING PRICE ONLY —
 * it plays no part in cost. These are deliberately not conflated.
 */
function computePricingBreakdown({
  netWeight,
  purity,
  wastagePercentage = 0,
  makingChargeType = 'percentage',
  makingChargeValue = 0,
  purchaseMetalRate,
  purchaseCost,
  currentMetalRate,
  taxPercentage = 0,
}) {
  const effectiveGoldPercentage = purity + (wastagePercentage || 0);
  const currentCost = netWeight * (effectiveGoldPercentage / 100) * currentMetalRate;

  // Pure-metal value at purity (no wastage) — this is the customer-facing base.
  const basePrice = netWeight * (purity / 100) * currentMetalRate;
  const makingChargeAmount = computeMakingChargeAmount({ netWeight, makingChargeType, makingChargeValue, currentMetalRate });
  const laborCost = 0; // retired concept — making charge fully captures this now, don't double count

  const subtotal = basePrice + makingChargeAmount + laborCost; // == sellingPrice, pre-tax
  const tax = subtotal * ((taxPercentage || 0) / 100);
  const finalPrice = subtotal + tax;

  return {
    // ---- original keys, preserved exactly for backward compatibility ----
    spotPricePerGram: currentMetalRate,
    weightGrams: netWeight,
    basePrice: round2(basePrice),
    markup: round2(makingChargeAmount),
    laborCost: round2(laborCost),
    subtotal: round2(subtotal),
    tax: round2(tax),
    finalPrice: round2(finalPrice),

    // ---- new additive fields ----
    purity,
    wastagePercentage: wastagePercentage || 0,
    effectiveGoldPercentage,
    makingChargeType,
    makingChargeValue,
    makingChargeAmount: round2(makingChargeAmount),
    purchaseMetalRate,
    purchaseCost: purchaseCost != null ? round2(purchaseCost) : undefined,
    currentMetalRate,
    currentCost: round2(currentCost),
  };
}

async function getCurrentMetalRate(metalType, session) {
  return PreciousMetalRate.findOne({ metalType }).sort({ createdAt: -1 }).session(session || null);
}

async function getPriceBreakdownForProduct(product, session) {
  const [currentRate, pricingRule] = await Promise.all([
    getCurrentMetalRate(product.metalType, session),
    PricingRule.findOne({ metalType: product.metalType }).session(session || null),
  ]);

  if (!currentRate) {
    throw new Error(`No current metal rate configured for ${product.metalType}`);
  }
  if (!pricingRule) {
    throw new Error(`No pricing rule configured for ${product.metalType}`);
  }

  return computePricingBreakdown({
    netWeight: product.netWeight,
    purity: product.purity,
    wastagePercentage: product.wastagePercentage || 0,
    makingChargeType: product.makingChargeType || 'percentage',
    makingChargeValue: product.makingChargeValue || 0,
    purchaseMetalRate: product.purchaseMetalRate,
    purchaseCost: product.purchaseCost,
    currentMetalRate: currentRate.ratePerGram,
    taxPercentage: pricingRule.taxPercentage || 0,
  });
}

/**
 * Builds a per-line order/invoice item from a product + quantity, applying an
 * optional flat per-line discount netted out of the line's finalPrice (floored at 0).
 * This is the single source of truth for the "per-unit price breakdown x quantity"
 * math shared by orderController.buildOrderItem and the sales checkout flow.
 */
async function buildLineItem(product, quantity, discount = 0, session) {
  const price = await getPriceBreakdownForProduct(product, session);
  const rawFinalPrice = price.finalPrice * quantity - (discount || 0);
  return {
    productId: product._id,
    name: product.name,
    metalType: product.metalType,
    purity: product.purity,
    weightGrams: product.weightGrams,
    quantity,
    spotPrice: round2(price.basePrice * quantity),
    markup: round2(price.markup * quantity),
    laborCost: round2(price.laborCost * quantity),
    tax: round2(price.tax * quantity),
    discount: discount || 0,
    finalPrice: round2(Math.max(0, rawFinalPrice)),
    // Print-layout snapshot — see Invoice's item schema for why these are
    // captured now rather than looked up again at invoice/PDF time.
    hsnCode: product.hsnCode || '',
    grossWeight: product.grossWeight,
    netWeight: product.netWeight,
    ratePerGram: price.currentMetalRate,
  };
}

/**
 * Prices a custom/made-to-order item that has no Product yet — same formula
 * and output shape (spotPrice/markup/laborCost/tax/finalPrice) as buildLineItem,
 * just fed raw specs instead of a document. Nothing is persisted here; the
 * caller (orderController) decides what to do with the returned line item.
 */
function buildCustomOrderItem(spec, currentMetalRate, taxPercentage) {
  const price = computePricingBreakdown({
    netWeight: spec.estimatedWeight,
    purity: spec.purity,
    wastagePercentage: spec.wastagePercentage || 0,
    makingChargeType: spec.makingChargeType || 'percentage',
    makingChargeValue: spec.makingChargeValue || 0,
    purchaseMetalRate: currentMetalRate, // no purchase-time snapshot exists yet for an unmade item
    currentMetalRate,
    taxPercentage,
  });
  const quantity = spec.quantity || 1;
  return {
    isCustomOrder: true,
    name: spec.itemName,
    category: spec.category || '',
    description: spec.description || '',
    metalType: spec.metalType,
    purity: spec.purity,
    wastagePercentage: spec.wastagePercentage || 0,
    weightGrams: spec.estimatedWeight, // virtual-compatible field name, see Product's own weightGrams alias for precedent
    estimatedWeight: spec.estimatedWeight,
    sizeValue: spec.sizeValue,
    sizeUnit: spec.sizeUnit,
    // The quoted making-charge terms, frozen — "mark ready" defaults to these.
    makingChargeType: spec.makingChargeType || 'percentage',
    makingChargeValue: spec.makingChargeValue || 0,
    quantity,
    spotPrice: round2(price.basePrice * quantity),
    markup: round2(price.markup * quantity),
    laborCost: round2(price.laborCost * quantity),
    tax: round2(price.tax * quantity),
    finalPrice: round2(price.finalPrice * quantity),
    estimatedPrice: round2(price.finalPrice * quantity),
    fulfillmentStatus: 'pending',
  };
}

/**
 * Maps one order item (already priced) onto an invoice item — the shared shape
 * used by both the order->invoice flow and the atomic sales-checkout flow, so
 * the print-layout fields (HSN, purity, weights, rate, labour) are populated
 * identically everywhere an invoice gets created.
 */
function buildInvoiceLineFromOrderItem(orderItem) {
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
  };
}

/**
 * Computes invoice-level totals from a set of order items (each already carrying
 * a per-line finalPrice/tax), plus an optional order-level flat discount.
 * subtotal = sum(finalPrice - tax); taxAmount = sum(tax); finalAmount = subtotal + taxAmount - discount.
 */
function computeInvoiceTotals(orderItems, orderDiscount = 0) {
  const subtotal = round2(orderItems.reduce((sum, i) => sum + (i.finalPrice - i.tax), 0));
  const taxAmount = round2(orderItems.reduce((sum, i) => sum + i.tax, 0));
  const discount = orderDiscount || 0;
  const finalAmount = round2(subtotal + taxAmount - discount);
  return { subtotal, taxAmount, discount, finalAmount };
}

module.exports = {
  computeMakingChargeAmount,
  computePricingBreakdown,
  getCurrentMetalRate,
  getPriceBreakdownForProduct,
  buildLineItem,
  buildCustomOrderItem,
  buildInvoiceLineFromOrderItem,
  computeInvoiceTotals,
  round2,
};
