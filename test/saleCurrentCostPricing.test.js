/**
 * Regression coverage for the Current Cost -> Making Charge -> Selling Price
 * pipeline in the Sales module. This replaces an earlier /tmp/ throwaway
 * integration script — that script caught real bugs but, being disposable,
 * left this exact area (calculateSaleLine/calculateSale) with zero permanent
 * regression coverage, which is how the Current-Cost-vs-Selling-Price
 * conflation this file exists to catch got through in the first place.
 *
 * Runs against an ISOLATED scratch database — never jewellery_shop_management.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

require('dotenv').config();

const SCRATCH = 'jewellery_currentcost_test_scratch';
const originalUri = process.env.MONGO_URI;

// Every other file in test/ is a pure unit test with no external dependency,
// so `npm test` works in any checkout. This file needs a real MongoDB to
// verify the actual pricing pipeline end to end — skip cleanly rather than
// fail hard when no database is configured (e.g. a clean checkout with no
// .env yet), so the rest of the suite still runs green.
if (!originalUri) {
  test('Current Cost pricing pipeline (skipped — MONGO_URI not configured)', { skip: true }, () => {});
  return;
}
process.env.MONGO_URI = originalUri.replace(/\/jewellery_shop_management\?/, `/${SCRATCH}?`);

const connectDB = require('../src/config/db');
const Customer = require('../src/models/Customer');
const Product = require('../src/models/Product');
const PreciousMetalRate = require('../src/models/PreciousMetalRate');
const PricingRule = require('../src/models/PricingRule');
const Order = require('../src/models/Order');
const Invoice = require('../src/models/Invoice');
const AuditLog = require('../src/models/AuditLog');
const StockTransaction = require('../src/models/StockTransaction');
const { getPriceBreakdownForProduct, round2 } = require('../src/services/pricingService');
const { calculateSaleLine, calculateSale } = require('../src/services/saleCalculationService');
const { recordPayment } = require('../src/services/paymentService');

let product;
let customerMH;

test.before(async () => {
  if (!originalUri || !process.env.MONGO_URI.includes(SCRATCH)) {
    throw new Error('Refusing to run: could not isolate MONGO_URI to the scratch database');
  }
  await connectDB();
  if (mongoose.connection.name !== SCRATCH) {
    throw new Error(`Refusing to run: connected to "${mongoose.connection.name}", not "${SCRATCH}"`);
  }

  await PreciousMetalRate.create({ metalType: 'gold', ratePerGram: 7500, sourceType: 'MANUAL', source: 'manual', status: 'ACTIVE' });
  await PricingRule.create({ metalType: 'gold', taxPercentage: 3 });

  // The exact fixture from the bug report's own worked example: 10gm, 91.6%
  // purity, 4% wastage, ₹7,500/gm -> Current Cost ₹71,700.
  product = await Product.create({
    name: 'Test Gold Chain', type: 'necklace', metalType: 'gold', purity: 91.6,
    grossWeight: 10, netWeight: 10, wastagePercentage: 4,
    makingChargeType: 'percentage', makingChargeValue: 10,
    purchaseMetalRate: 7000, purchaseCost: 7000 * 10 * 0.956, sku: 'TEST-CHAIN-CC-001', quantity: 10,
  });

  customerMH = await Customer.create({ name: 'Test CC Customer', phone: '9000000099', state: 'Maharashtra' });
});

test.after(async () => {
  const cols = await mongoose.connection.db.listCollections().toArray();
  for (const c of cols) await mongoose.connection.db.collection(c.name).deleteMany({});
  await mongoose.disconnect();
});

test('Current Cost matches the bug report\'s own worked example exactly', async () => {
  const line = await calculateSaleLine({ product, quantity: 1, discount: 0 });
  assert.strictEqual(line.currentCost, 71700, `10 x 0.956 x 7500 = 71700 (${line.currentCost})`);
});

test('Cart Current Cost is IDENTICAL to the Product page\'s own Current Cost — same function, same number', async () => {
  const productPageBreakdown = await getPriceBreakdownForProduct(product);
  const cartLine = await calculateSaleLine({ product, quantity: 1, discount: 0 });
  assert.strictEqual(cartLine.currentCost, productPageBreakdown.currentCost, 'Product and Cart must never disagree');
});

test('percentage making charge: amount = value% of Current Cost, not of raw weight x rate', async () => {
  const line = await calculateSaleLine({ product, quantity: 1, discount: 0, makingChargeOverride: { type: 'percentage', value: 10 } });
  assert.strictEqual(line.makingChargeAmount, 7170, `10% of 71700 = 7170 (${line.makingChargeAmount})`);
  assert.strictEqual(line.sellingPrice, 78870, `71700 + 7170 = 78870 (${line.sellingPrice})`);
});

test('per-gram making charge: amount = weight x rate/gram, unchanged from before', async () => {
  const line = await calculateSaleLine({ product, quantity: 1, discount: 0, makingChargeOverride: { type: 'per_gram', value: 500 } });
  assert.strictEqual(line.makingChargeAmount, 5000, `10g x 500/g = 5000 (${line.makingChargeAmount})`);
  assert.strictEqual(line.sellingPrice, 76700, `71700 + 5000 = 76700 (${line.sellingPrice})`);
});

test('making-charge adjustment never changes Current Cost — only Making Charge and Selling Price move', async () => {
  const atDefault = await calculateSaleLine({ product, quantity: 1, discount: 0 });
  const adjusted = await calculateSaleLine({ product, quantity: 1, discount: 0, makingChargeOverride: { type: 'percentage', value: 5 } });
  assert.strictEqual(atDefault.currentCost, adjusted.currentCost, 'Current Cost must be identical regardless of making charge');
  assert.notStrictEqual(atDefault.sellingPrice, adjusted.sellingPrice, 'Selling Price must change with making charge');
  assert.strictEqual(adjusted.makingChargeAmount, 3585, `5% of 71700 = 3585 (${adjusted.makingChargeAmount})`);
});

test('no double-counting: Selling Price - Current Cost equals exactly the Making Charge amount (pre-discount)', async () => {
  const line = await calculateSaleLine({ product, quantity: 1, discount: 0, makingChargeOverride: { type: 'percentage', value: 8 } });
  assert.strictEqual(round2(line.sellingPrice - line.currentCost), line.makingChargeAmount);
});

test('selling price EQUAL to current cost: not flagged below cost (boundary)', async () => {
  const line = await calculateSaleLine({ product, quantity: 1, discount: 0, makingChargeOverride: { type: 'percentage', value: 0 } });
  assert.strictEqual(line.sellingPrice, line.currentCost);
  assert.strictEqual(line.belowCurrentCost, false);
});

test('selling price BELOW current cost: flagged, via a discount that eats into the making charge and below', async () => {
  // 0% making charge -> sellingPrice would equal currentCost (71700); a 5000
  // discount pushes the final price under it.
  const line = await calculateSaleLine({ product, quantity: 1, discount: 5000, makingChargeOverride: { type: 'percentage', value: 0 } });
  assert.strictEqual(line.sellingPrice, 66700, `71700 - 5000 = 66700 (${line.sellingPrice})`);
  assert.strictEqual(line.belowCurrentCost, true);
  assert.strictEqual(line.difference, -5000);
});

test('selling price ABOVE current cost: not flagged, positive difference', async () => {
  const line = await calculateSaleLine({ product, quantity: 1, discount: 0, makingChargeOverride: { type: 'percentage', value: 12 } });
  assert.strictEqual(line.belowCurrentCost, false);
  assert.ok(line.difference > 0);
});

test('multiple products: totals sum each product\'s own Current Cost / Making Charge / Selling Price', async () => {
  const product2 = await Product.create({
    name: 'Test Gold Ring', type: 'ring', metalType: 'gold', purity: 91.6,
    grossWeight: 5, netWeight: 5, wastagePercentage: 2,
    makingChargeType: 'per_gram', makingChargeValue: 400,
    purchaseMetalRate: 7000, purchaseCost: 7000 * 5 * 0.936, sku: 'TEST-RING-CC-001', quantity: 10,
  });
  const sale = await calculateSale({
    items: [
      { productId: product._id, quantity: 1, makingChargeOverride: { type: 'percentage', value: 10 } },
      { productId: product2._id, quantity: 1 },
    ],
    billingType: 'NON_GST', customerState: 'Maharashtra', canAdjustMakingCharge: true,
  });
  const [line1, line2] = sale.lines;
  assert.strictEqual(sale.currentCostTotal, round2(line1.currentCost + line2.currentCost));
  assert.strictEqual(sale.makingChargeTotal, round2(line1.makingChargeAmount + line2.makingChargeAmount));
  assert.strictEqual(sale.subtotal, round2(line1.sellingPrice + line2.sellingPrice));
  await Product.deleteOne({ _id: product2._id });
});

test('GST sale: tax computed on the post-making-charge selling price', async () => {
  const sale = await calculateSale({
    items: [{ productId: product._id, quantity: 1, makingChargeOverride: { type: 'percentage', value: 10 } }],
    billingType: 'GST', customerState: 'Maharashtra', canAdjustMakingCharge: true,
  });
  assert.strictEqual(sale.taxableAmount, 78870);
  assert.strictEqual(sale.taxAmount, round2(78870 * 0.03));
  assert.strictEqual(sale.grandTotal, round2(78870 + 78870 * 0.03));
});

test('Non-GST sale: zero tax, grand total equals taxable amount', async () => {
  const sale = await calculateSale({
    items: [{ productId: product._id, quantity: 1, makingChargeOverride: { type: 'percentage', value: 10 } }],
    billingType: 'NON_GST', customerState: 'Maharashtra', canAdjustMakingCharge: true,
  });
  assert.strictEqual(sale.taxAmount, 0);
  assert.strictEqual(sale.grandTotal, sale.taxableAmount);
});

test('unauthorized making-charge override is stripped: falls back to the product default, Current Cost unaffected either way', async () => {
  const sale = await calculateSale({
    items: [{ productId: product._id, quantity: 1, makingChargeOverride: { type: 'percentage', value: 1 } }],
    billingType: 'GST', customerState: 'Maharashtra', canAdjustMakingCharge: false,
  });
  const line = sale.lines[0];
  assert.strictEqual(line.makingChargeOverrideIgnored, true);
  assert.strictEqual(line.saleMakingChargeValue, product.makingChargeValue, 'falls back to default (10%)');
  assert.strictEqual(line.currentCost, 71700, 'Current Cost never depends on making charge permission');
});

test('full checkout: stores Current Cost snapshot on the order item, decrements stock, records payment, audits the making-charge override', async () => {
  const rateBefore = await PreciousMetalRate.findOne({ metalType: 'gold' }).sort({ createdAt: -1 });
  assert.strictEqual(rateBefore.ratePerGram, 7500);

  const calc = await calculateSale({
    items: [{ productId: product._id, quantity: 1, makingChargeOverride: { type: 'percentage', value: 8 } }],
    billingType: 'GST', customerState: 'Maharashtra', canAdjustMakingCharge: true,
  });
  const line = calc.lines[0];

  const before = await Product.findById(product._id);
  const p = await Product.findById(product._id);
  p.quantity -= line.quantity;
  await p.save();
  await StockTransaction.create({ productId: p._id, type: 'sale', quantity: -line.quantity, costPerUnit: round2(line.finalPrice / line.quantity), notes: 'test' });

  const order = await Order.create({
    customerId: customerMH._id,
    items: [{
      productId: line.productId, name: line.name, metalType: line.metalType, purity: line.purity,
      weightGrams: line.weightGrams, quantity: line.quantity, spotPrice: line.currentCost, markup: line.makingChargeAmount,
      laborCost: 0, tax: line.tax, finalPrice: line.finalPrice, discount: line.discount,
      currentCostAtSale: line.currentCost, defaultMakingChargeType: line.defaultMakingChargeType,
      defaultMakingChargeValue: line.defaultMakingChargeValue, saleMakingChargeType: line.saleMakingChargeType,
      saleMakingChargeValue: line.saleMakingChargeValue,
    }],
    totalAmount: calc.grandTotal, billingType: calc.billingType, isInterState: calc.isInterState,
    cgstAmount: calc.cgstAmount, sgstAmount: calc.sgstAmount, igstAmount: calc.igstAmount,
  });

  const invoice = await Invoice.create({
    invoiceNumber: `TEST-CC-${Date.now()}`, orderId: order._id, customerId: customerMH._id,
    items: order.items.map((i) => ({
      productId: i.productId, name: i.name, quantity: i.quantity, unitPrice: i.finalPrice / i.quantity, totalPrice: i.finalPrice,
      currentCostAtSale: i.currentCostAtSale, defaultMakingChargeType: i.defaultMakingChargeType,
      defaultMakingChargeValue: i.defaultMakingChargeValue, saleMakingChargeType: i.saleMakingChargeType, saleMakingChargeValue: i.saleMakingChargeValue,
    })),
    subtotal: calc.taxableAmount, discount: 0, taxAmount: calc.taxAmount, finalAmount: calc.grandTotal,
    billingType: calc.billingType, isInterState: calc.isInterState, cgstAmount: calc.cgstAmount, sgstAmount: calc.sgstAmount, igstAmount: calc.igstAmount,
  });

  await AuditLog.create({
    entity: 'Sale', entityId: order._id, field: `makingCharge:${line.productId}`,
    oldValue: { type: line.defaultMakingChargeType, value: line.defaultMakingChargeValue },
    newValue: { type: line.saleMakingChargeType, value: line.saleMakingChargeValue }, reason: 'Making charge adjusted at sale',
  });

  const after = await Product.findById(product._id);
  assert.strictEqual(after.quantity, before.quantity - 1, 'inventory decremented');
  assert.strictEqual(order.items[0].currentCostAtSale, 71700, 'order item stores the Current Cost snapshot, not Selling Price');
  assert.strictEqual(order.items[0].defaultMakingChargeValue, 10);
  assert.strictEqual(order.items[0].saleMakingChargeValue, 8);
  assert.strictEqual(invoice.finalAmount, round2((71700 + 71700 * 0.08) * 1.03));

  const payResult = await recordPayment({ invoiceId: invoice._id, amount: 20000, method: 'cash' });
  assert.strictEqual(payResult.invoice.paymentStatus, 'partial');

  const audited = await AuditLog.findOne({ entityId: order._id, field: `makingCharge:${line.productId}` });
  assert.ok(audited, 'making-charge override audited');
  assert.strictEqual(audited.newValue.value, 8);

  // Historical-snapshot guarantee: change the live rate AFTER the sale, and
  // confirm the already-created order/invoice are untouched.
  await PreciousMetalRate.create({ metalType: 'gold', ratePerGram: 7800, sourceType: 'MANUAL', source: 'manual', status: 'ACTIVE' });
  const reloadedOrder = await Order.findById(order._id);
  const reloadedInvoice = await Invoice.findById(invoice._id);
  assert.strictEqual(reloadedOrder.items[0].currentCostAtSale, 71700, 'unaffected by a later rate change');
  assert.strictEqual(reloadedInvoice.finalAmount, invoice.finalAmount, 'unaffected by a later rate change');

  // But a FRESH calculation for the same product now reflects the new rate.
  const freshLine = await calculateSaleLine({ product: await Product.findById(product._id), quantity: 1, discount: 0 });
  assert.strictEqual(freshLine.currentCost, round2(10 * 0.956 * 7800), 'new calculations use the live rate');
  assert.notStrictEqual(freshLine.currentCost, 71700);
});
