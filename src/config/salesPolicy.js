/**
 * Business-configurable sales rules. No Settings collection exists in this
 * codebase yet (rate-sync and shop-stationery config both live in env vars —
 * see rateProvider.js / shopProfile.js), so this follows the same pattern
 * rather than introducing a new persistence layer for two flags.
 */
const BILLING_TYPES = ['GST', 'NON_GST'];

const config = {
  get defaultBillingType() {
    const v = (process.env.DEFAULT_BILLING_TYPE || 'GST').toUpperCase();
    return BILLING_TYPES.includes(v) ? v : 'GST';
  },
  /**
   * true  — a below-current-value sale is a confirmation step; any salesperson
   *         may continue after acknowledging it.
   * false — only a user holding APPROVE_BELOW_VALUE_SALE may continue.
   */
  get allowBelowCurrentPriceSale() {
    return (process.env.ALLOW_BELOW_CURRENT_PRICE_SALE ?? 'true').toLowerCase() !== 'false';
  },
};

module.exports = { BILLING_TYPES, config };
