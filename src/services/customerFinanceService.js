const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Order = require('../models/Order');
const { round2 } = require('./pricingService');

/**
 * Everything in this file is read-only aggregation over Invoice + Payment.
 * Customer.totalPurchases (a running counter maintained elsewhere for
 * historical/loyalty purposes) is never used as the source of truth here —
 * outstanding balances and purchase totals are always recomputed from the
 * underlying transactions, per the module's core rule that these figures must
 * never become independent, manually-editable values.
 */

/**
 * Bulk outstanding/purchase totals for many customers in two queries total,
 * regardless of how many customers there are — used by the customer list so
 * showing a Pending column doesn't cost one query per row.
 */
async function bulkFinancials(customerIds) {
  const match = customerIds && customerIds.length ? { customerId: { $in: customerIds } } : {};

  const [invoiceRows, paymentRows, orderRows] = await Promise.all([
    Invoice.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$customerId',
          totalInvoiced: { $sum: '$finalAmount' },
          invoiceCount: { $sum: 1 },
          lastInvoiceDate: { $max: '$invoiceDate' },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { ...match, status: 'ACTIVE' } },
      { $group: { _id: '$customerId', totalPaid: { $sum: '$amount' } } },
    ]),
    Order.aggregate([
      { $match: match },
      { $group: { _id: '$customerId', orderCount: { $sum: 1 } } },
    ]),
  ]);

  const byCustomer = new Map();
  const ensure = (id) => {
    const key = String(id);
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        totalInvoiced: 0,
        invoiceCount: 0,
        totalPaid: 0,
        orderCount: 0,
        lastInvoiceDate: null,
      });
    }
    return byCustomer.get(key);
  };

  for (const row of invoiceRows) {
    const entry = ensure(row._id);
    entry.totalInvoiced = round2(row.totalInvoiced || 0);
    entry.invoiceCount = row.invoiceCount || 0;
    entry.lastInvoiceDate = row.lastInvoiceDate || null;
  }
  for (const row of paymentRows) {
    ensure(row._id).totalPaid = round2(row.totalPaid || 0);
  }
  for (const row of orderRows) {
    ensure(row._id).orderCount = row.orderCount || 0;
  }

  for (const entry of byCustomer.values()) {
    const rawOutstanding = round2(entry.totalInvoiced - entry.totalPaid);
    // Outstanding is never shown negative — an overpayment (e.g. a carried-
    // over deposit larger than the final bill) is a credit, not "extra debt".
    entry.pendingBalance = Math.max(0, rawOutstanding);
    entry.creditBalance = round2(Math.max(0, -rawOutstanding));
    entry.paymentStatus = entry.invoiceCount === 0 ? 'no-invoices' : entry.pendingBalance > 0 ? 'outstanding' : 'paid';
  }

  return byCustomer;
}

async function financialsFor(customerId) {
  const map = await bulkFinancials([new mongoose.Types.ObjectId(customerId)]);
  return (
    map.get(String(customerId)) || {
      totalInvoiced: 0,
      invoiceCount: 0,
      totalPaid: 0,
      orderCount: 0,
      pendingBalance: 0,
      creditBalance: 0,
      paymentStatus: 'no-invoices',
      lastInvoiceDate: null,
    }
  );
}

/** Every invoice for a customer, each annotated with its own balance — the "Purchase History" table. */
async function listPurchases(customerId) {
  const invoices = await Invoice.find({ customerId })
    .sort({ invoiceDate: -1 })
    .populate('orderId', 'orderNumber status');

  const invoiceIds = invoices.map((inv) => inv._id);
  const payments = await Payment.find({ invoiceId: { $in: invoiceIds }, status: 'ACTIVE' });
  const paidByInvoice = new Map();
  for (const p of payments) {
    const key = String(p.invoiceId);
    paidByInvoice.set(key, round2((paidByInvoice.get(key) || 0) + p.amount));
  }

  return invoices.map((inv) => {
    const paid = paidByInvoice.get(String(inv._id)) || 0;
    return {
      _id: inv._id,
      invoiceNumber: inv.invoiceNumber,
      orderId: inv.orderId,
      invoiceDate: inv.invoiceDate,
      items: inv.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      finalAmount: inv.finalAmount,
      amountPaid: paid,
      balance: round2(inv.finalAmount - paid),
      paymentStatus: inv.paymentStatus,
    };
  });
}

/**
 * Chronological debit/credit ledger: every invoice is a debit, every active
 * payment a credit, running balance computed in date order. Reversed
 * payments are excluded — a voided payment never happened, financially.
 */
async function customerLedger(customerId) {
  const [invoices, payments] = await Promise.all([
    Invoice.find({ customerId }).select('invoiceNumber invoiceDate finalAmount'),
    Payment.find({ customerId, status: 'ACTIVE' })
      .select('invoiceId amount date method reference createdBy')
      .populate('invoiceId', 'invoiceNumber')
      .populate('createdBy', 'username'),
  ]);

  const entries = [
    ...invoices.map((inv) => ({
      date: inv.invoiceDate,
      type: 'invoice',
      reference: inv.invoiceNumber,
      debit: round2(inv.finalAmount),
      credit: 0,
      sortKey: `1-${new Date(inv.invoiceDate).getTime()}`,
    })),
    ...payments.map((p) => ({
      date: p.date,
      type: 'payment',
      reference: p.invoiceId ? p.invoiceId.invoiceNumber : null,
      method: p.method,
      recordedBy: p.createdBy ? p.createdBy.username : null,
      debit: 0,
      credit: round2(p.amount),
      // Payments sort after an invoice dated the same instant, so a same-day
      // deposit reads as reducing the bill it was collected against.
      sortKey: `2-${new Date(p.date).getTime()}`,
    })),
  ].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  let running = 0;
  return entries.map((e) => {
    running = round2(running + e.debit - e.credit);
    const { sortKey, ...rest } = e;
    void sortKey;
    return { ...rest, balance: running };
  });
}

async function listPayments(customerId) {
  return Payment.find({ customerId })
    .sort({ date: -1 })
    .populate('invoiceId', 'invoiceNumber')
    .populate('createdBy', 'username role');
}

module.exports = { bulkFinancials, financialsFor, listPurchases, customerLedger, listPayments };
