/**
 * One-off backfill for rate rows created before source/status tracking existed.
 *
 * Only ever fills in MISSING metadata: sourceType, status, currency, city.
 * The recorded rate, its author and its timestamps are never touched, so this
 * cannot change any price the shop has already quoted.
 *
 * Run with: npm run backfill:rates
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const PreciousMetalRate = require('../models/PreciousMetalRate');

async function backfill() {
  await connectDB();
  console.log(`Database: ${mongoose.connection.name}`);

  const missing = await PreciousMetalRate.countDocuments({ sourceType: { $exists: false } });
  const total = await PreciousMetalRate.countDocuments();
  console.log(`Rate rows: ${total} total, ${missing} missing provenance`);

  if (missing === 0) {
    console.log('Nothing to backfill.');
    await mongoose.disconnect();
    return;
  }

  // Pre-existing rows were all entered by hand — the live feed did not exist.
  const marked = await PreciousMetalRate.updateMany(
    { sourceType: { $exists: false } },
    { $set: { sourceType: 'MANUAL', source: 'manual' } }
  );
  console.log(`Marked ${marked.modifiedCount} rows as MANUAL`);

  await PreciousMetalRate.updateMany({ currency: { $exists: false } }, { $set: { currency: 'INR' } });
  await PreciousMetalRate.updateMany({ city: { $exists: false } }, { $set: { city: 'Mumbai' } });

  // Exactly one ACTIVE row per metal: the most recent one.
  for (const metalType of ['gold', 'silver']) {
    const latest = await PreciousMetalRate.findOne({ metalType }).sort({ createdAt: -1 });
    if (!latest) continue;
    await PreciousMetalRate.updateMany({ metalType }, { $set: { status: 'SUPERSEDED' } });
    await PreciousMetalRate.updateOne({ _id: latest._id }, { $set: { status: 'ACTIVE' } });
    console.log(`${metalType}: ACTIVE = ${latest.ratePerGram}/g (${latest._id})`);
  }

  await mongoose.disconnect();
  console.log('Backfill complete.');
}

if (require.main === module) {
  backfill().catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exit(1);
  });
}

module.exports = backfill;
