const asyncHandler = require('express-async-handler');
const { parse } = require('csv-parse/sync');
const Product = require('../models/Product');
const StockTransaction = require('../models/StockTransaction');
const PreciousMetalRate = require('../models/PreciousMetalRate');
const PricingRule = require('../models/PricingRule');
const AuditLog = require('../models/AuditLog');
const {
  getPriceBreakdownForProduct,
  computePricingBreakdown,
  round2,
} = require('../services/pricingService');
const { getStockLevel } = require('../utils/stockLevel');

const PRODUCT_TYPES = ['ring', 'necklace', 'bracelet', 'earring', 'pendant'];
const METAL_TYPES = ['gold', 'silver'];
const MAKING_CHARGE_TYPES = ['percentage', 'per_gram'];

// Pricing-sensitive fields that only admin/manager may change on an EXISTING
// product. Creating a brand-new product with these fields is fine for any
// authenticated staff member — there's nothing to "override" yet.
const RESTRICTED_UPDATE_FIELDS = ['wastagePercentage', 'makingChargeType', 'makingChargeValue', 'purchaseCost'];
const AUDITED_FIELDS = ['purity', 'wastagePercentage', 'makingChargeType', 'makingChargeValue', 'purchaseCost'];

async function withPrice(product) {
  const plain = product.toObject ? product.toObject() : product;
  const level = getStockLevel(plain.quantity);
  try {
    const price = await getPriceBreakdownForProduct(plain);
    return { ...plain, price, level };
  } catch (err) {
    return { ...plain, price: null, priceError: err.message, level };
  }
}

async function currentRateFor(metalType) {
  return PreciousMetalRate.findOne({ metalType }).sort({ createdAt: -1 });
}

function computePurchaseCost({ netWeight, purity, wastagePercentage, purchaseMetalRate }) {
  const effectiveGoldPercentage = Number(purity) + Number(wastagePercentage || 0);
  return round2(Number(netWeight) * (effectiveGoldPercentage / 100) * Number(purchaseMetalRate));
}

const createProduct = asyncHandler(async (req, res) => {
  const body = { ...req.body };

  // purchaseMetalRate is a frozen snapshot — auto-fill it from the current
  // PreciousMetalRate if the caller didn't supply one explicitly.
  if (body.purchaseMetalRate == null) {
    const rate = await currentRateFor(body.metalType);
    if (!rate) {
      res.status(400);
      throw new Error(
        `No current metal rate configured for ${body.metalType}; provide purchaseMetalRate explicitly or seed a PreciousMetalRate first`
      );
    }
    body.purchaseMetalRate = rate.ratePerGram;
  }

  const netWeight = body.netWeight != null ? body.netWeight : body.weightGrams;
  if (netWeight == null || body.purity == null) {
    res.status(400);
    throw new Error('netWeight and purity are required');
  }

  // purchaseCost is always derived server-side at creation time from the
  // formula — it is never trusted from client input on create.
  body.purchaseCost = computePurchaseCost({
    netWeight,
    purity: body.purity,
    wastagePercentage: body.wastagePercentage,
    purchaseMetalRate: body.purchaseMetalRate,
  });

  const product = await Product.create(body);
  res.status(201).json(await withPrice(product));
});

const listProducts = asyncHandler(async (req, res) => {
  const { metalType, type, q } = req.query;
  const filter = {};
  if (metalType) filter.metalType = metalType;
  if (type) filter.type = type;
  if (q) {
    const re = new RegExp(q, 'i');
    filter.$or = [{ name: re }, { sku: re }, { barcode: re }, { category: re }];
  }
  const products = await Product.find(filter).sort({ createdAt: -1 });
  const withPrices = await Promise.all(products.map(withPrice));
  res.json(withPrices);
});

const getProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404);
    throw new Error('Product not found');
  }
  res.json(await withPrice(product));
});

const updateProduct = asyncHandler(async (req, res) => {
  const body = { ...req.body };

  const touchedRestricted = RESTRICTED_UPDATE_FIELDS.filter((f) =>
    Object.prototype.hasOwnProperty.call(body, f)
  );
  if (touchedRestricted.length > 0 && req.user && req.user.role === 'staff') {
    res.status(403);
    throw new Error(
      `Forbidden: staff cannot modify ${touchedRestricted.join(', ')} on an existing product. Ask an admin or manager.`
    );
  }

  const existing = await Product.findById(req.params.id);
  if (!existing) {
    res.status(404);
    throw new Error('Product not found');
  }

  // If underlying cost inputs change but the caller didn't ALSO explicitly
  // supply purchaseCost themselves, recompute it automatically so it stays
  // consistent with the corrected inputs. An explicit purchaseCost in the
  // same request is treated as a deliberate admin/manager override and wins.
  const costInputsTouched = ['netWeight', 'purity', 'wastagePercentage', 'purchaseMetalRate'].some((f) =>
    Object.prototype.hasOwnProperty.call(body, f)
  );
  if (costInputsTouched && !Object.prototype.hasOwnProperty.call(body, 'purchaseCost')) {
    body.purchaseCost = computePurchaseCost({
      netWeight: body.netWeight != null ? body.netWeight : existing.netWeight,
      purity: body.purity != null ? body.purity : existing.purity,
      wastagePercentage: body.wastagePercentage != null ? body.wastagePercentage : existing.wastagePercentage,
      purchaseMetalRate: body.purchaseMetalRate != null ? body.purchaseMetalRate : existing.purchaseMetalRate,
    });
  }

  const auditEntries = [];
  for (const field of AUDITED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field) && String(body[field]) !== String(existing[field])) {
      auditEntries.push({
        entity: 'Product',
        entityId: existing._id,
        field,
        oldValue: existing[field],
        newValue: body[field],
        userId: req.user && req.user._id,
        reason: body.reason || '',
      });
    }
  }

  Object.assign(existing, body);
  await existing.save();

  if (auditEntries.length > 0) {
    await AuditLog.create(auditEntries);
  }

  res.json(await withPrice(existing));
});

const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) {
    res.status(404);
    throw new Error('Product not found');
  }
  res.json({ message: 'Product deleted' });
});

const updateStock = asyncHandler(async (req, res) => {
  const { quantity, notes } = req.body;
  if (quantity == null) {
    res.status(400);
    throw new Error('quantity is required');
  }
  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404);
    throw new Error('Product not found');
  }

  const delta = quantity - product.quantity;
  product.quantity = quantity;
  await product.save();

  if (delta !== 0) {
    await StockTransaction.create({
      productId: product._id,
      type: 'adjustment',
      quantity: delta,
      notes: notes || '',
      performedBy: req.user && req.user._id,
    });
  }

  res.json(product);
});

/**
 * POST /api/products/pricing/preview
 *
 * Forward mode (any authenticated user): given the raw jewellery inputs,
 * returns the full pricing breakdown WITHOUT persisting anything — used for
 * "recalculate as you type" while creating/editing a product.
 *
 * Reverse mode (admin/manager only): given a target sellingPrice or
 * purchaseCost, algebraically solves for the required makingChargeValue /
 * wastagePercentage. Nothing is persisted; the frontend shows the derived
 * value and the user decides whether to accept it.
 */
const pricingPreview = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const isReverse = body.targetSellingPrice != null || body.targetPurchaseCost != null;

  if (isReverse) {
    if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
      res.status(403);
      throw new Error('Forbidden: reverse target-price calculation requires admin or manager role');
    }

    const result = {};

    if (body.targetSellingPrice != null) {
      const { targetSellingPrice, netWeight, purity, currentMetalRate, mode } = body;
      if (netWeight == null || purity == null || currentMetalRate == null || !mode) {
        res.status(400);
        throw new Error('netWeight, purity, currentMetalRate and mode are required to solve for a target selling price');
      }
      if (!MAKING_CHARGE_TYPES.includes(mode)) {
        res.status(400);
        throw new Error(`mode must be one of ${MAKING_CHARGE_TYPES.join(', ')}`);
      }
      if (mode === 'percentage') {
        const requiredMakingChargePct =
          Number(targetSellingPrice) / ((Number(netWeight) * Number(currentMetalRate)) / 100) - Number(purity);
        result.makingChargeType = 'percentage';
        result.makingChargeValue = round2(requiredMakingChargePct);
      } else {
        const requiredMakingChargePerGram =
          (Number(targetSellingPrice) - (Number(netWeight) * Number(purity)) / 100 * Number(currentMetalRate)) /
          Number(netWeight);
        result.makingChargeType = 'per_gram';
        result.makingChargeValue = round2(requiredMakingChargePerGram);
      }
    }

    if (body.targetPurchaseCost != null) {
      const { targetPurchaseCost, netWeight, purity, purchaseMetalRate } = body;
      if (netWeight == null || purity == null || purchaseMetalRate == null) {
        res.status(400);
        throw new Error('netWeight, purity and purchaseMetalRate are required to solve for a target purchase cost');
      }
      const requiredWastagePct =
        Number(targetPurchaseCost) / ((Number(netWeight) * Number(purchaseMetalRate)) / 100) - Number(purity);
      result.wastagePercentage = round2(requiredWastagePct);
    }

    return res.json(result);
  }

  // ---- forward mode: any authenticated user ----
  const {
    netWeight,
    purity,
    wastagePercentage = 0,
    makingChargeType = 'percentage',
    makingChargeValue = 0,
    purchaseMetalRate,
    currentMetalRate,
    metalType,
  } = body;

  if (netWeight == null || purity == null || purchaseMetalRate == null || currentMetalRate == null) {
    res.status(400);
    throw new Error('netWeight, purity, purchaseMetalRate and currentMetalRate are required');
  }
  if (!MAKING_CHARGE_TYPES.includes(makingChargeType)) {
    res.status(400);
    throw new Error(`makingChargeType must be one of ${MAKING_CHARGE_TYPES.join(', ')}`);
  }

  let taxPercentage = 0;
  if (metalType) {
    const rule = await PricingRule.findOne({ metalType });
    taxPercentage = rule ? rule.taxPercentage || 0 : 0;
  }

  const purchaseCost = computePurchaseCost({ netWeight, purity, wastagePercentage, purchaseMetalRate });

  const breakdown = computePricingBreakdown({
    netWeight: Number(netWeight),
    purity: Number(purity),
    wastagePercentage: Number(wastagePercentage),
    makingChargeType,
    makingChargeValue: Number(makingChargeValue),
    purchaseMetalRate: Number(purchaseMetalRate),
    purchaseCost,
    currentMetalRate: Number(currentMetalRate),
    taxPercentage,
  });

  res.json(breakdown);
});

const importProducts = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('CSV file is required (field name "file")');
  }

  let records;
  try {
    records = parse(req.file.buffer.toString('utf-8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    res.status(400);
    throw new Error(`Failed to parse CSV: ${err.message}`);
  }

  const existingSkus = new Set((await Product.find({}, 'sku')).map((p) => p.sku));
  const seenSkus = new Set();
  const errors = [];
  const validDocs = [];

  // Preload current metal rates once so rows that omit purchaseMetalRate can
  // fall back to it without a per-row query.
  const currentRates = {};
  for (const mt of METAL_TYPES) {
    const rate = await currentRateFor(mt);
    if (rate) currentRates[mt] = rate.ratePerGram;
  }

  records.forEach((row, idx) => {
    const rowNum = idx + 1;
    const {
      name,
      type,
      metalType,
      purity,
      grossWeight,
      netWeight,
      sku,
      quantity,
      description,
      wastagePercentage,
      makingChargeType,
      makingChargeValue,
      purchaseMetalRate,
    } = row;

    if (!name || !type || !metalType || !purity || !grossWeight || !netWeight || !sku) {
      errors.push({
        row: rowNum,
        sku: sku || undefined,
        message:
          'Missing required field(s): name, type, metalType, purity, grossWeight, netWeight, sku are all required',
      });
      return;
    }
    if (!PRODUCT_TYPES.includes(type)) {
      errors.push({ row: rowNum, sku, message: `Invalid type "${type}". Must be one of: ${PRODUCT_TYPES.join(', ')}` });
      return;
    }
    if (!METAL_TYPES.includes(metalType)) {
      errors.push({ row: rowNum, sku, message: `Invalid metalType "${metalType}". Must be one of: ${METAL_TYPES.join(', ')}` });
      return;
    }
    const purityNum = Number(purity);
    if (Number.isNaN(purityNum) || purityNum <= 0 || purityNum > 100) {
      errors.push({
        row: rowNum,
        sku,
        message: `Invalid purity "${purity}" — must be a number between 0 and 100 (e.g. 91.6 for 22K gold), not a karat label`,
      });
      return;
    }
    const gross = Number(grossWeight);
    if (Number.isNaN(gross) || gross <= 0) {
      errors.push({ row: rowNum, sku, message: `Invalid grossWeight "${grossWeight}"` });
      return;
    }
    const net = Number(netWeight);
    if (Number.isNaN(net) || net <= 0) {
      errors.push({ row: rowNum, sku, message: `Invalid netWeight "${netWeight}"` });
      return;
    }
    if (net > gross) {
      errors.push({ row: rowNum, sku, message: 'netWeight cannot exceed grossWeight' });
      return;
    }
    const qty = quantity == null || quantity === '' ? 0 : Number(quantity);
    if (Number.isNaN(qty) || qty < 0) {
      errors.push({ row: rowNum, sku, message: `Invalid quantity "${quantity}"` });
      return;
    }
    if (existingSkus.has(sku) || seenSkus.has(sku)) {
      errors.push({ row: rowNum, sku, message: `Duplicate SKU "${sku}"` });
      return;
    }

    const wastage = wastagePercentage == null || wastagePercentage === '' ? 0 : Number(wastagePercentage);
    if (Number.isNaN(wastage) || wastage < 0) {
      errors.push({ row: rowNum, sku, message: `Invalid wastagePercentage "${wastagePercentage}"` });
      return;
    }
    const mcType = MAKING_CHARGE_TYPES.includes(makingChargeType) ? makingChargeType : 'percentage';
    const mcValue = makingChargeValue == null || makingChargeValue === '' ? 0 : Number(makingChargeValue);
    if (Number.isNaN(mcValue) || mcValue < 0) {
      errors.push({ row: rowNum, sku, message: `Invalid makingChargeValue "${makingChargeValue}"` });
      return;
    }

    let rate = purchaseMetalRate == null || purchaseMetalRate === '' ? currentRates[metalType] : Number(purchaseMetalRate);
    if (rate == null || Number.isNaN(rate)) {
      errors.push({
        row: rowNum,
        sku,
        message: `No purchaseMetalRate provided and no current PreciousMetalRate configured for ${metalType}`,
      });
      return;
    }

    const purchaseCost = computePurchaseCost({ netWeight: net, purity: purityNum, wastagePercentage: wastage, purchaseMetalRate: rate });

    seenSkus.add(sku);
    validDocs.push({
      name,
      type,
      metalType,
      purity: purityNum,
      grossWeight: gross,
      netWeight: net,
      sku,
      quantity: qty,
      description: description || '',
      wastagePercentage: wastage,
      makingChargeType: mcType,
      makingChargeValue: mcValue,
      purchaseMetalRate: rate,
      purchaseCost,
    });
  });

  let insertedCount = 0;
  if (validDocs.length > 0) {
    try {
      const inserted = await Product.insertMany(validDocs, { ordered: false });
      insertedCount = inserted.length;
    } catch (err) {
      // With ordered:false, mongoose/mongo still inserts the non-conflicting docs
      // and reports failures via err.insertedDocs / err.writeErrors when duplicates slip through.
      insertedCount = err.insertedDocs ? err.insertedDocs.length : 0;
      const failedIndexes = new Set((err.writeErrors || []).map((we) => we.index));
      failedIndexes.forEach((i) => {
        const doc = validDocs[i];
        errors.push({ row: undefined, sku: doc && doc.sku, message: 'Insert failed (likely duplicate SKU)' });
      });
      if (!err.writeErrors) {
        // Unexpected error shape; rethrow so it isn't silently swallowed
        throw err;
      }
    }
  }

  res.status(201).json({ insertedCount, errors });
});

module.exports = {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  updateStock,
  importProducts,
  pricingPreview,
};
