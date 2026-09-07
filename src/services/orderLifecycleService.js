const Order = require('../models/Order');
const Product = require('../models/Product');
const StockTransaction = require('../models/StockTransaction');
const { round2 } = require('./pricingService');

/**
 * Order status lifecycle.
 *
 * Statuses only ever move FORWARD through this ranking, and 'cancelled' is
 * terminal — automation must never resurrect a cancelled order, nor drag an
 * order backwards (e.g. a manually-advanced order shouldn't regress because a
 * later automated step fired). Anything not in this map is left alone.
 */
const STATUS_RANK = {
  draft: 0,
  pending: 1,
  confirmed: 2,
  processing: 3,
  in_manufacturing: 4,
  ready: 5,
  delivered: 6,
  completed: 7,
};

/**
 * Moves an order forward to `target` if — and only if — that's actually a
 * forward step. Returns true when the status changed. Does NOT save.
 */
function promoteStatus(order, target) {
  if (!order || order.status === 'cancelled') return false;
  const currentRank = STATUS_RANK[order.status];
  const targetRank = STATUS_RANK[target];
  if (currentRank === undefined || targetRank === undefined) return false;
  if (targetRank <= currentRank) return false;
  order.status = target;
  return true;
}

/** Sum of the advance ledger — the same derivation the order controller exposes. */
function advanceTotalFor(order) {
  return round2((order.advancePayments || []).reduce((sum, p) => sum + (p.amount || 0), 0));
}

/**
 * Builds a unique SKU for a product auto-created from an order item, e.g.
 * "Short Necklace" -> "SN-0001". Falls back to the metal, then to "ITM", when
 * the category is empty or has no usable letters. Loops until it finds a free
 * one, since `sku` is unique-indexed.
 */
async function generateSku(category, metalType, session) {
  const words = String(category || '')
    .replace(/[^a-zA-Z ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let prefix = words
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
  if (!prefix) prefix = metalType === 'silver' ? 'SLV' : metalType === 'gold' ? 'GLD' : 'ITM';

  const existing = await Product.countDocuments().session(session || null);
  let sequence = existing + 1;
  // Bounded so a pathological collision run can never spin forever.
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `${prefix}-${String(sequence).padStart(4, '0')}`;
    const clash = await Product.findOne({ sku: candidate }).session(session || null);
    if (!clash) return candidate;
    sequence += 1;
  }
  // Astronomically unlikely; keeps the caller from silently getting a dupe.
  return `${prefix}-${Date.now()}`;
}

/**
 * Same formula productController uses for a product's frozen purchase cost.
 * Wastage counts toward cost (never toward the selling price) — see
 * pricingService.computePricingBreakdown for why those are kept separate.
 */
function computePurchaseCost({ netWeight, purity, wastagePercentage, purchaseMetalRate }) {
  const effectiveGoldPercentage = Number(purity) + Number(wastagePercentage || 0);
  return round2(Number(netWeight) * (effectiveGoldPercentage / 100) * Number(purchaseMetalRate));
}

// Rough category-name -> Product.type heuristic. The Product `type` enum
// (ring|necklace|bracelet|earring|pendant) predates the free-text Category
// Master used by custom orders, so there's no guaranteed exact match.
const CATEGORY_TO_PRODUCT_TYPE = {
  ring: 'ring',
  necklace: 'necklace',
  mangalsutra: 'necklace',
  chain: 'necklace',
  choker: 'necklace',
  chokar: 'necklace',
  bracelet: 'bracelet',
  bangle: 'bracelet',
  kada: 'bracelet',
  earring: 'earring',
  tops: 'earring',
  bali: 'earring',
  jhumka: 'earring',
  pendant: 'pendant',
  locket: 'pendant',
};

function inferProductType(category) {
  const key = String(category || '').trim().toLowerCase();
  if (!key) return 'pendant';
  if (CATEGORY_TO_PRODUCT_TYPE[key]) return CATEGORY_TO_PRODUCT_TYPE[key];
  const match = Object.keys(CATEGORY_TO_PRODUCT_TYPE).find((needle) => key.includes(needle));
  return match ? CATEGORY_TO_PRODUCT_TYPE[match] : 'pendant';
}

/**
 * Turns a "ready" custom order item into real sellable inventory: creates the
 * Product, writes the matching 'purchase' StockTransaction (stock arriving from
 * the karigar, the inverse of a sale), and links the product back onto the
 * order item. Mutates `item` but does NOT save the order — the caller owns that.
 *
 * Shared by both the automatic path (marking an item ready) and the explicit
 * convert-to-product endpoint, so inventory is created identically either way.
 */
async function createProductFromOrderItem({ order, item, sku, barcode, image, quantity, userId, session }) {
  const finalQuantity = quantity != null ? Number(quantity) : item.quantity || 1;
  const purchaseCost = computePurchaseCost({
    netWeight: item.finalNetWeight,
    purity: item.finalPurity,
    wastagePercentage: item.wastagePercentage,
    purchaseMetalRate: item.finalGoldRate,
  });

  const effectiveSku = sku || (await generateSku(item.category, item.metalType, session));

  const [product] = await Product.create(
    [
      {
        name: item.name,
        type: inferProductType(item.category),
        metalType: item.metalType,
        category: item.category || '',
        description: item.description || '',
        grossWeight: item.finalGrossWeight,
        netWeight: item.finalNetWeight,
        purity: item.finalPurity,
        wastagePercentage: item.wastagePercentage || 0,
        makingChargeType: item.finalMakingChargeType || 'percentage',
        makingChargeValue: item.finalMakingChargeValue || 0,
        purchaseMetalRate: item.finalGoldRate,
        purchaseCost,
        sku: effectiveSku,
        barcode: barcode || undefined,
        image: image || '',
        quantity: finalQuantity,
      },
    ],
    { session }
  );

  await StockTransaction.create(
    [
      {
        productId: product._id,
        type: 'purchase',
        quantity: finalQuantity,
        costPerUnit: purchaseCost,
        notes: `Manufactured from Order ${order._id}`,
        performedBy: userId,
      },
    ],
    { session }
  );

  item.productId = product._id;
  item.fulfillmentStatus = 'converted';
  return product;
}

/**
 * When every custom item on an order is manufactured (ready or already turned
 * into stock), the order itself is ready for the customer to collect.
 * Stock-linked items are ignored — they were never being manufactured.
 */
function promoteOrderIfAllItemsReady(order) {
  const customItems = (order.items || []).filter((i) => i.isCustomOrder);
  if (customItems.length === 0) return false;
  const allDone = customItems.every((i) => i.fulfillmentStatus === 'ready' || i.fulfillmentStatus === 'converted');
  return allDone ? promoteStatus(order, 'ready') : false;
}

/**
 * Applies the post-sale lifecycle rules:
 *   goods handed over            -> delivered
 *   delivered AND fully paid     -> completed
 *
 * Runs against BOTH the order created by the sale itself and any earlier
 * custom/made-to-order orders whose manufactured piece was the thing sold
 * (matched by productId), since fulfilling a custom order happens on a
 * different order document than the one that recorded the original request.
 */
async function applySaleToOrders({ productIds, saleOrderId, isFullyPaid, session }) {
  const touched = [];

  if (saleOrderId) {
    const saleOrder = await Order.findById(saleOrderId).session(session || null);
    if (saleOrder) {
      let changed = promoteStatus(saleOrder, 'delivered');
      if (isFullyPaid) changed = promoteStatus(saleOrder, 'completed') || changed;
      if (changed) {
        await saleOrder.save({ session });
        touched.push(saleOrder._id);
      }
    }
  }

  const ids = (productIds || []).filter(Boolean);
  if (ids.length > 0) {
    const linkedOrders = await Order.find({
      _id: { $ne: saleOrderId },
      items: { $elemMatch: { isCustomOrder: true, productId: { $in: ids } } },
    }).session(session || null);

    for (const linked of linkedOrders) {
      let changed = promoteStatus(linked, 'delivered');
      if (isFullyPaid) changed = promoteStatus(linked, 'completed') || changed;
      if (changed) {
        await linked.save({ session });
        touched.push(linked._id);
      }
    }
  }

  return touched;
}

/**
 * An order already handed over becomes 'completed' once its own advance ledger
 * covers the total. Used after recording an advance payment — an order that is
 * fully paid but NOT yet delivered stays where it is, since completion means
 * both sides of the transaction are done.
 */
function promoteIfDeliveredAndPaid(order) {
  if (!order || order.status !== 'delivered') return false;
  if (advanceTotalFor(order) < (order.totalAmount || 0)) return false;
  return promoteStatus(order, 'completed');
}

module.exports = {
  STATUS_RANK,
  promoteStatus,
  advanceTotalFor,
  generateSku,
  inferProductType,
  computePurchaseCost,
  createProductFromOrderItem,
  promoteOrderIfAllItemsReady,
  applySaleToOrders,
  promoteIfDeliveredAndPaid,
};
