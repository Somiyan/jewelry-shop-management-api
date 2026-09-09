const asyncHandler = require('express-async-handler');
const Customer = require('../models/Customer');
const { bulkFinancials, financialsFor, listPurchases, customerLedger, listPayments } = require('../services/customerFinanceService');

const createCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.create(req.body);
  res.status(201).json(customer);
});

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  'highest-outstanding': (a, b) => b.pendingBalance - a.pendingBalance,
  'lowest-outstanding': (a, b) => a.pendingBalance - b.pendingBalance,
  'highest-purchase': (a, b) => b.totalInvoiced - a.totalInvoiced,
  'recent-purchase': (a, b) => new Date(b.lastInvoiceDate || 0) - new Date(a.lastInvoiceDate || 0),
};

/**
 * GET /api/customers?q=&outstanding=all|outstanding|paid|none&sort=...
 *
 * Each customer is annotated with pendingBalance/totalInvoiced/totalPaid,
 * always recomputed from Invoice+Payment (never Customer.totalPurchases,
 * which is a separate legacy running counter) — one bulk aggregation
 * regardless of how many customers there are, not one query per row.
 */
const listCustomers = asyncHandler(async (req, res) => {
  const { q, outstanding, sort } = req.query;
  const filter = q ? { $or: [{ name: new RegExp(q, 'i') }, { phone: new RegExp(q, 'i') }] } : {};

  const customers = await Customer.find(filter).sort({ createdAt: -1 });
  const financials = await bulkFinancials(customers.map((c) => c._id));

  let annotated = customers.map((c) => {
    const f = financials.get(String(c._id)) || {
      totalInvoiced: 0,
      invoiceCount: 0,
      totalPaid: 0,
      orderCount: 0,
      pendingBalance: 0,
      creditBalance: 0,
      paymentStatus: 'no-invoices',
      lastInvoiceDate: null,
    };
    return { ...c.toObject(), ...f };
  });

  if (outstanding === 'outstanding') annotated = annotated.filter((c) => c.pendingBalance > 0);
  else if (outstanding === 'paid' || outstanding === 'none') {
    annotated = annotated.filter((c) => c.pendingBalance === 0 && c.invoiceCount > 0);
  }

  if (sort && SORTS[sort]) annotated.sort(SORTS[sort]);

  res.json(annotated);
});

const getCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }
  res.json(customer);
});

const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }
  res.json(customer);
});

const searchByPhone = asyncHandler(async (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    res.status(400);
    throw new Error('phone query param is required');
  }
  const customers = await Customer.find({ phone: new RegExp(phone, 'i') });
  res.json(customers);
});

/** GET /api/customers/:id/summary — the KPI cards on the customer profile page. */
const getCustomerSummary = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }
  const financials = await financialsFor(customer._id);
  res.json({ customer, ...financials });
});

/** GET /api/customers/:id/purchases — every invoice for this customer with its own balance. */
const getCustomerPurchases = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }
  const purchases = await listPurchases(customer._id);
  res.json(purchases);
});

/** GET /api/customers/:id/ledger — chronological debit/credit ledger with running balance. */
const getCustomerLedger = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }
  const ledger = await customerLedger(customer._id);
  res.json(ledger);
});

/** GET /api/customers/:id/payments — every payment this customer has made, across all invoices. */
const getCustomerPayments = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    res.status(404);
    throw new Error('Customer not found');
  }
  const payments = await listPayments(customer._id);
  res.json(payments);
});

module.exports = {
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
  searchByPhone,
  getCustomerSummary,
  getCustomerPurchases,
  getCustomerLedger,
  getCustomerPayments,
};
