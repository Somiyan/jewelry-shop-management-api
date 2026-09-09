/**
 * One-off backfill for invoices created before this module existed.
 *
 * Every invoice already stores `amountPaid` (set directly at checkout/status
 * update, before payments had their own ledger). This creates exactly ONE
 * Payment row per such invoice, equal to that recorded amount, tagged
 * `source: 'legacy-migration'` — so the new ledger reflects a real historical
 * fact rather than inventing one, and every downstream figure (customer
 * outstanding, purchase history, the ledger) is correct for existing data
 * from the moment this feature ships, not only for invoices created after it.
 *
 * Idempotent: an invoice that already has any Payment row (of any source) is
 * left untouched, so running this twice is harmless.
 *
 * Run with: npm run backfill:payments
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const { recordPayment } = require('../services/paymentService');

async function backfill() {
  await connectDB();
  console.log(`Database: ${mongoose.connection.name}`);

  const candidates = await Invoice.find({ amountPaid: { $gt: 0 } });
  console.log(`Invoices with amountPaid > 0: ${candidates.length}`);

  let created = 0;
  let skipped = 0;

  for (const invoice of candidates) {
    const existing = await Payment.countDocuments({ invoiceId: invoice._id });
    if (existing > 0) {
      skipped += 1;
      continue;
    }

    try {
      await recordPayment({
        invoiceId: invoice._id,
        amount: invoice.amountPaid,
        method: invoice.paymentMethod || 'cash',
        date: invoice.invoiceDate,
        notes: 'Backfilled from invoice.amountPaid (recorded before per-payment tracking existed)',
        source: 'legacy-migration',
        // A pre-existing recorded amount is a historical fact, not a new
        // transaction to validate against today's outstanding balance.
        allowOverpayment: true,
      });
      created += 1;
      console.log(`  ${invoice.invoiceNumber}: backfilled ${invoice.amountPaid}`);
    } catch (err) {
      console.error(`  ${invoice.invoiceNumber}: FAILED — ${err.message}`);
    }
  }

  console.log(`Backfilled ${created} invoice(s), skipped ${skipped} (already had payment records).`);
  await mongoose.disconnect();
}

if (require.main === module) {
  backfill().catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exit(1);
  });
}

module.exports = backfill;
