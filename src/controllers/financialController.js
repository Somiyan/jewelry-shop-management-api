const asyncHandler = require('express-async-handler');
const FinancialTransaction = require('../models/FinancialTransaction');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const { getPriceBreakdownForProduct } = require('../services/pricingService');

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const getDashboard = asyncHandler(async (req, res) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const monthStart = startOfMonth(now);

  const [
    dailySalesAgg,
    monthlySalesAgg,
    totalExpensesAgg,
    invoiceCount,
    outstandingAgg,
    collectedTodayAgg,
    totalCollectedAgg,
  ] = await Promise.all([
    FinancialTransaction.aggregate([
      { $match: { type: 'sale', date: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    FinancialTransaction.aggregate([
      { $match: { type: 'sale', date: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    FinancialTransaction.aggregate([
      { $match: { type: 'expense', date: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Invoice.countDocuments(),
    // Per-invoice outstanding, clamped at 0 before summing — an invoice that
    // somehow over-collected is a credit, not negative debt cancelling out
    // another customer's real balance.
    Invoice.aggregate([
      {
        $lookup: {
          from: 'payments',
          let: { invoiceId: '$_id' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$invoiceId', '$$invoiceId'] }, { $eq: ['$status', 'ACTIVE'] }] } } }],
          as: 'activePayments',
        },
      },
      {
        $addFields: {
          paid: { $sum: '$activePayments.amount' },
        },
      },
      {
        $addFields: {
          outstanding: { $max: [0, { $subtract: ['$finalAmount', '$paid'] }] },
        },
      },
      {
        $group: {
          _id: null,
          totalOutstanding: { $sum: '$outstanding' },
          pendingInvoices: { $sum: { $cond: [{ $gt: ['$outstanding', 0] }, 1, 0] } },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { status: 'ACTIVE', date: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      { $match: { status: 'ACTIVE' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const dailySales = dailySalesAgg[0]?.total || 0;
  const monthlyRevenue = monthlySalesAgg[0]?.total || 0;
  const monthlyExpenses = totalExpensesAgg[0]?.total || 0;
  const profitMargin = monthlyRevenue > 0 ? ((monthlyRevenue - monthlyExpenses) / monthlyRevenue) * 100 : 0;

  res.json({
    dailySales,
    monthlyRevenue,
    monthlyExpenses,
    profitMargin: Math.round(profitMargin * 100) / 100,
    totalInvoices: invoiceCount,
    // Derived from Invoice + Payment records, same as every other balance in
    // this module — never a separately maintained running total.
    totalOutstanding: outstandingAgg[0]?.totalOutstanding || 0,
    pendingInvoices: outstandingAgg[0]?.pendingInvoices || 0,
    collectedToday: collectedTodayAgg[0]?.total || 0,
    totalCollected: totalCollectedAgg[0]?.total || 0,
  });
});

const getRevenue = asyncHandler(async (req, res) => {
  const { period = 'daily' } = req.query;
  const groupId =
    period === 'yearly'
      ? { $dateToString: { format: '%Y', date: '$date' } }
      : period === 'monthly'
      ? { $dateToString: { format: '%Y-%m', date: '$date' } }
      : { $dateToString: { format: '%Y-%m-%d', date: '$date' } };

  const data = await FinancialTransaction.aggregate([
    { $match: { type: 'sale' } },
    { $group: { _id: groupId, revenue: { $sum: '$amount' } } },
    { $sort: { _id: 1 } },
  ]);

  res.json(data.map((d) => ({ period: d._id, revenue: d.revenue })));
});

const getProfitLoss = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = {};
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = new Date(startDate);
    if (endDate) match.date.$lte = new Date(endDate);
  }

  const totals = await FinancialTransaction.aggregate([
    { $match: match },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);

  const byType = totals.reduce((acc, t) => ({ ...acc, [t._id]: t.total }), {});
  const revenue = byType.sale || 0;
  const expenses = byType.expense || 0;
  const purchases = byType.purchase || 0;
  const returns = byType.return || 0;
  const netProfit = revenue - expenses - purchases - returns;

  res.json({ revenue, expenses, purchases, returns, netProfit });
});

const getTransactions = asyncHandler(async (req, res) => {
  const { type } = req.query;
  const filter = type ? { type } : {};
  const transactions = await FinancialTransaction.find(filter).sort({ date: -1 });
  res.json(transactions);
});

const getInventoryValue = asyncHandler(async (req, res) => {
  const products = await Product.find();
  let totalValue = 0;
  const breakdown = [];
  for (const product of products) {
    try {
      const price = await getPriceBreakdownForProduct(product);
      const lineValue = price.finalPrice * product.quantity;
      totalValue += lineValue;
      breakdown.push({ productId: product._id, name: product.name, quantity: product.quantity, unitValue: price.finalPrice, lineValue });
    } catch (err) {
      breakdown.push({ productId: product._id, name: product.name, quantity: product.quantity, error: err.message });
    }
  }
  res.json({ totalValue: Math.round(totalValue * 100) / 100, breakdown });
});

module.exports = { getDashboard, getRevenue, getProfitLoss, getTransactions, getInventoryValue };
