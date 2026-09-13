const Product = require('../models/Product');
const {
  computePricingBreakdown,
  computeMakingChargeOnCurrentCost,
  fetchRateAndRule,
  determineIsInterState,
  splitGst,
  round2,
} = require('./pricingService');
const { config: salesPolicy, BILLING_TYPES } = require('../config/salesPolicy');
const shopProfile = require('../config/shopProfile');

/**
 * The Sales module's pricing core. Everything here is pure/read-only against
 * the database (no writes) — it is the single function BOTH the live
 * "Calculate Sale" preview endpoint and checkout's own server-side
 * recalculation call, so a preview can never show the customer a number the
 * backend would then charge them something different for.
 *
 * The pricing pipeline, per line:
 *   Current Cost  (Product's own wastage-inclusive cost, unchanged by anything here)
 *     + Making Charge  (percentage of Current Cost, or a flat ₹/gram)
 *     = Selling Price  (- this line's own discount)
 *
 * Current Cost is fetched via computePricingBreakdown — the SAME calculation
 * the Product page's own "Current Cost" field uses — never recomputed
 * differently here, so Product and Cart always show an identical figure for
 * the same product. Making charge is applied exactly once, on top of it;
 * Current Cost itself carries no making charge, so there is no double-count.
 */
async function calculateSaleLine({ product, quantity, discount = 0, makingChargeOverride }, session) {
  const { currentRate, pricingRule } = await fetchRateAndRule(product.metalType, session);
  const taxPercentage = pricingRule.taxPercentage || 0;
  const lineQuantity = Math.max(1, Number(quantity) || 1);

  const defaultMakingChargeType = product.makingChargeType || 'percentage';
  const defaultMakingChargeValue = product.makingChargeValue || 0;

  // Current Cost only depends on weight/purity/wastage/rate — never on making
  // charge — so one call (at the product's default terms) is all that's
  // needed to get it; computing it twice for "default" vs "sale" would just
  // recompute the identical number.
  const productPricing = computePricingBreakdown({
    netWeight: product.netWeight,
    purity: product.purity,
    wastagePercentage: product.wastagePercentage || 0,
    makingChargeType: defaultMakingChargeType,
    makingChargeValue: defaultMakingChargeValue,
    purchaseMetalRate: product.purchaseMetalRate,
    purchaseCost: product.purchaseCost,
    currentMetalRate: currentRate.ratePerGram,
    taxPercentage,
  });
  const currentCostPerUnit = productPricing.currentCost;

  const saleMakingChargeType = makingChargeOverride?.type || defaultMakingChargeType;
  const saleMakingChargeValue =
    makingChargeOverride?.value != null ? Number(makingChargeOverride.value) : defaultMakingChargeValue;

  const makingChargeAmountPerUnit = computeMakingChargeOnCurrentCost({
    currentCost: currentCostPerUnit,
    netWeight: product.netWeight,
    makingChargeType: saleMakingChargeType,
    makingChargeValue: saleMakingChargeValue,
  });

  const currentCost = round2(currentCostPerUnit * lineQuantity);
  const makingChargeAmount = round2(makingChargeAmountPerUnit * lineQuantity);
  const lineDiscount = Math.max(0, Number(discount) || 0);
  const calculatedSellingPrice = round2(currentCost + makingChargeAmount);
  const sellingPrice = round2(Math.max(0, calculatedSellingPrice - lineDiscount));
  // GST is decided at the invoice level by billing type (see calculateSale);
  // this is this line's own pre-discount-ratio share of it.
  const lineTax = round2(sellingPrice * (taxPercentage / 100));

  const difference = round2(sellingPrice - currentCost);
  const marginPercent = currentCost > 0 ? round2((difference / currentCost) * 100) : 0;
  // A paisa of rounding dust must never itself trigger a below-cost warning.
  const belowCurrentCost = difference < -0.01;

  return {
    productId: product._id,
    name: product.name,
    metalType: product.metalType,
    quantity: lineQuantity,
    purity: product.purity,
    grossWeight: product.grossWeight,
    netWeight: product.netWeight,
    weightGrams: product.netWeight,
    hsnCode: product.hsnCode || '',
    goldRate: currentRate.ratePerGram,
    ratePerGram: currentRate.ratePerGram,

    currentCost,
    defaultMakingChargeType,
    defaultMakingChargeValue,
    saleMakingChargeType,
    saleMakingChargeValue,
    makingChargeAdjusted: saleMakingChargeType !== defaultMakingChargeType || saleMakingChargeValue !== defaultMakingChargeValue,
    makingChargeAmount,
    discount: lineDiscount,
    calculatedSellingPrice,
    sellingPrice,
    tax: lineTax,

    difference,
    marginPercent,
    belowCurrentCost,
  };
}

/**
 * Full-sale calculation: prices every line, applies billing type (GST split
 * or none), and reports a structured below-cost warning per line rather than
 * one generic invoice-level flag — per-item, because a mixed cart can have
 * some lines above and some below their current cost at once.
 *
 * `canAdjustMakingCharge` is enforced HERE, not trusted from the caller: an
 * override from a user without ADJUST_MAKING_CHARGES is dropped and flagged,
 * regardless of what the request body asked for. This is what makes the
 * making-charge field "read-only" for an unauthorized user in a way the
 * frontend cannot bypass.
 */
async function calculateSale({
  items,
  billingType,
  customerState,
  canAdjustMakingCharge = false,
  orderDiscount = 0,
  session,
} = {}) {
  const resolvedBillingType = BILLING_TYPES.includes(billingType) ? billingType : salesPolicy.defaultBillingType;

  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('At least one item is required'), { status: 400 });
  }

  const lines = [];
  for (let idx = 0; idx < items.length; idx += 1) {
    const raw = items[idx];
    if (!raw || !raw.productId) {
      throw Object.assign(new Error(`items[${idx}].productId is required`), { status: 400 });
    }
    const product = await Product.findById(raw.productId).session(session || null);
    if (!product) {
      throw Object.assign(new Error(`Product not found: ${raw.productId}`), { status: 404 });
    }

    const requestedOverride = raw.makingChargeOverride;
    const overrideIgnored = Boolean(requestedOverride) && !canAdjustMakingCharge;
    const effectiveOverride = canAdjustMakingCharge ? requestedOverride : undefined;

    const line = await calculateSaleLine(
      { product, quantity: raw.quantity, discount: raw.discount, makingChargeOverride: effectiveOverride },
      session
    );
    lines.push({ ...line, makingChargeOverrideIgnored: overrideIgnored });
  }

  const currentCostTotal = round2(lines.reduce((sum, l) => sum + l.currentCost, 0));
  const makingChargeTotal = round2(lines.reduce((sum, l) => sum + l.makingChargeAmount, 0));
  const lineDiscountTotal = round2(lines.reduce((sum, l) => sum + l.discount, 0));
  const subtotal = round2(lines.reduce((sum, l) => sum + l.sellingPrice, 0));

  const effectiveOrderDiscount = Math.max(0, Number(orderDiscount) || 0);
  const taxableAmount = round2(Math.max(0, subtotal - effectiveOrderDiscount));

  // Order-level discount is applied before tax (per this module's calculation
  // sequence), so each line's own tax is scaled down by the same ratio the
  // discount reduced the overall subtotal. This keeps GST proportional to
  // what the customer is actually being taxed on while still respecting each
  // line's own metal-specific tax rate.
  const discountRatio = subtotal > 0 ? taxableAmount / subtotal : 1;
  const rawTaxTotal = round2(lines.reduce((sum, l) => sum + l.tax, 0) * discountRatio);

  const isInterState = resolvedBillingType === 'GST' ? determineIsInterState(shopProfile.state, customerState) : false;

  let taxAmount = 0;
  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;
  if (resolvedBillingType === 'GST') {
    taxAmount = rawTaxTotal;
    ({ cgstAmount, sgstAmount, igstAmount } = splitGst(taxAmount, isInterState));
  }

  const grandTotal = round2(taxableAmount + taxAmount);

  // Bake the final per-line tax (discount-ratio-adjusted, zeroed for a
  // Non-GST bill) directly into each line, so a caller storing `lines` on an
  // Order/Invoice item never has to re-derive it — this IS the number that
  // was actually charged for that line, and Σ line.tax reconciles with
  // taxAmount up to rounding.
  for (const line of lines) {
    line.tax = resolvedBillingType === 'GST' ? round2(line.tax * discountRatio) : 0;
    line.finalPrice = round2(line.sellingPrice + line.tax);
  }

  const warnings = lines
    .filter((l) => l.belowCurrentCost)
    .map((l) => ({
      warning: 'SELLING_BELOW_CURRENT_COST',
      productId: l.productId,
      productName: l.name,
      currentCost: l.currentCost,
      sellingValue: l.sellingPrice,
      difference: l.difference,
      requiresApproval: !salesPolicy.allowBelowCurrentPriceSale,
    }));

  return {
    billingType: resolvedBillingType,
    isInterState,
    shopGstin: shopProfile.gstin,
    shopState: shopProfile.state,
    lines,
    currentCostTotal,
    makingChargeTotal,
    lineDiscountTotal,
    subtotal,
    orderDiscount: effectiveOrderDiscount,
    taxableAmount,
    taxAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    grandTotal,
    warnings,
    allowBelowCurrentPriceSale: salesPolicy.allowBelowCurrentPriceSale,
  };
}

module.exports = { calculateSaleLine, calculateSale };
