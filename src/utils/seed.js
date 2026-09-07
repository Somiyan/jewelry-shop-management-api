require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const PricingRule = require('../models/PricingRule');
const MetalPrice = require('../models/MetalPrice');
const Category = require('../models/Category');

const DEFAULT_CATEGORIES = [
  'Chain',
  'Ear Ring',
  'Ear Tops',
  'Ear Chain',
  'Small Mangalsutra',
  'Big Mangalsutra',
  'Bali',
  'Gents Ring',
  'Ladies Ring',
  'Short Necklace',
  'Long Necklace',
];

async function seed() {
  await connectDB();

  const adminExists = await User.findOne({ username: 'admin' });
  if (!adminExists) {
    await User.create({
      username: 'admin',
      email: 'admin@jewelryshop.local',
      password: 'admin123',
      role: 'admin',
      permissions: ['*'],
    });
    console.log('Created default admin user (admin / admin123)');
  }

  await PricingRule.findOneAndUpdate(
    { metalType: 'gold' },
    {
      metalType: 'gold',
      pricingStrategy: 'hybrid',
      fixedMarkupPerGram: 20,
      percentageMarkup: 15,
      laborCostPerGram: 20,
      taxPercentage: 5,
    },
    { upsert: true }
  );

  await PricingRule.findOneAndUpdate(
    { metalType: 'silver' },
    {
      metalType: 'silver',
      pricingStrategy: 'percentage',
      fixedMarkupPerGram: 0,
      percentageMarkup: 12,
      laborCostPerGram: 5,
      taxPercentage: 3,
    },
    { upsert: true }
  );

  const seedPrices = [
    { metalType: 'gold', purity: '24K', spotPrice: 7600 },
    { metalType: 'gold', purity: '22K', spotPrice: 7000 },
    { metalType: 'gold', purity: '18K', spotPrice: 5700 },
    { metalType: 'silver', purity: '925', spotPrice: 95 },
  ];

  for (const p of seedPrices) {
    await MetalPrice.findOneAndUpdate(
      { metalType: p.metalType, purity: p.purity },
      { ...p, source: 'manual', lastUpdated: new Date() },
      { upsert: true }
    );
  }

  // Idempotent category master seed — check-then-insert, safe to run repeatedly.
  for (const name of DEFAULT_CATEGORIES) {
    const exists = await Category.findOne({ name });
    if (!exists) {
      await Category.create({ name });
      console.log(`Created category: ${name}`);
    }
  }

  console.log('Seed complete.');
  await mongoose.connection.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
