/**
 * One-off migration: converts Product.purity from a karat LABEL (enum
 * '24K'|'22K'|'18K'|'925') into the real purity PERCENTAGE (Number), and backfills
 * the new jewellery-pricing fields (grossWeight, netWeight, wastagePercentage,
 * makingChargeType, makingChargeValue, purchaseMetalRate, purchaseCost) that the
 * new pricing engine requires.
 *
 * Safe/idempotent: skips any document whose `purity` is already a Number
 * (i.e. already migrated). Only touches purity/grossWeight/netWeight/
 * wastagePercentage/makingChargeType/makingChargeValue/purchaseMetalRate/
 * purchaseCost — never name/sku/quantity/description/barcode/category, and
 * never touches any other collection.
 *
 * Run with: node src/utils/migrateProductPricingFields.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const KARAT_TO_PURITY = {
  '24K': 99.9,
  '22K': 91.6,
  '18K': 75.0,
  '925': 92.5,
};

async function migrate() {
  await connectDB();
  const db = mongoose.connection.db;
  const products = db.collection('products');

  const docs = await products.find({}).toArray();
  console.log(`Found ${docs.length} product document(s).`);

  console.log('\n=== BEFORE ===');
  console.log(JSON.stringify(docs, null, 2));

  // A placeholder purchase rate is only used if no PreciousMetalRate has been
  // seeded yet for gold. This test run seeds a real gold rate first (see
  // verification report), so this fallback should not normally be hit.
  const PLACEHOLDER_GOLD_RATE = 7000;
  const PLACEHOLDER_SILVER_RATE = 90;

  const rates = db.collection('preciousmetalrates');
  async function currentRate(metalType) {
    const r = await rates.find({ metalType }).sort({ createdAt: -1 }).limit(1).toArray();
    return r[0] ? r[0].ratePerGram : null;
  }

  let migratedCount = 0;
  for (const doc of docs) {
    if (typeof doc.purity === 'number') {
      console.log(`Skipping ${doc.sku} — purity is already numeric (${doc.purity}).`);
      continue;
    }

    const karatLabel = doc.purity;
    const purity = KARAT_TO_PURITY[karatLabel];
    if (purity == null) {
      console.warn(`WARNING: unknown purity label "${karatLabel}" on ${doc.sku}; skipping.`);
      continue;
    }

    const weight = doc.weightGrams;
    if (weight == null) {
      console.warn(`WARNING: ${doc.sku} has no weightGrams to migrate from; skipping.`);
      continue;
    }

    let purchaseMetalRate = await currentRate(doc.metalType);
    let rateSource = 'live PreciousMetalRate';
    if (purchaseMetalRate == null) {
      purchaseMetalRate = doc.metalType === 'silver' ? PLACEHOLDER_SILVER_RATE : PLACEHOLDER_GOLD_RATE;
      rateSource = 'placeholder (no PreciousMetalRate configured yet)';
    }

    const wastagePercentage = 0;
    const effectiveGoldPercentage = purity + wastagePercentage;
    const purchaseCost = Math.round(weight * (effectiveGoldPercentage / 100) * purchaseMetalRate * 100) / 100;

    const update = {
      purity,
      grossWeight: weight,
      netWeight: weight,
      wastagePercentage,
      makingChargeType: 'percentage',
      makingChargeValue: 0,
      purchaseMetalRate,
      purchaseCost,
    };

    console.log(
      `Migrating ${doc.sku}: purity "${karatLabel}" -> ${purity}, grossWeight=netWeight=${weight} (from old weightGrams — shop should verify true grossWeight later), purchaseMetalRate=${purchaseMetalRate} (${rateSource}), purchaseCost=${purchaseCost}`
    );

    await products.updateOne({ _id: doc._id }, { $set: update, $unset: { weightGrams: '' } });
    migratedCount += 1;
  }

  const after = await products.find({ sku: { $in: docs.map((d) => d.sku) } }).toArray();
  console.log('\n=== AFTER ===');
  console.log(JSON.stringify(after, null, 2));

  console.log(`\nMigration complete. ${migratedCount} document(s) migrated.`);
  await mongoose.connection.close();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
