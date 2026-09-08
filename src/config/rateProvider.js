/**
 * RapidAPI gold/silver rate provider configuration.
 *
 * The API key lives here and ONLY here — it is read from the environment and
 * never returned in any API response, log line, or error message.
 */
const config = {
  get url() {
    return process.env.RAPIDAPI_GOLD_SILVER_URL || 'https://gold-silver-rates-india.p.rapidapi.com/api/Fetch-Gold-Silver/';
  },
  get host() {
    return process.env.RAPIDAPI_HOST || 'gold-silver-rates-india.p.rapidapi.com';
  },
  get key() {
    return process.env.RAPIDAPI_KEY || '';
  },
  get city() {
    return process.env.RATE_PROVIDER_CITY || 'mumbai';
  },
  get timeoutMs() {
    return Number(process.env.RATE_PROVIDER_TIMEOUT_MS || 10000);
  },
  get maxAttempts() {
    return Number(process.env.RATE_PROVIDER_MAX_ATTEMPTS || 3);
  },
  get retryDelayMs() {
    return Number(process.env.RATE_PROVIDER_RETRY_DELAY_MS || 1000);
  },
  isConfigured() {
    return Boolean(this.key);
  },
};

/**
 * Plausibility bounds for a per-gram rate in INR.
 *
 * These are a safety net, not a nicety: the pricing engine multiplies the rate
 * by item weight, so a rate that is out by 10x (a per-10-gram quote read as
 * per-gram) would misprice every product in the shop. A rate outside these
 * bounds is rejected rather than stored.
 */
const PLAUSIBLE_PER_GRAM = {
  gold: {
    min: Number(process.env.RATE_GOLD_MIN_PER_GRAM || 2000),
    max: Number(process.env.RATE_GOLD_MAX_PER_GRAM || 40000),
  },
  silver: {
    min: Number(process.env.RATE_SILVER_MIN_PER_GRAM || 20),
    max: Number(process.env.RATE_SILVER_MAX_PER_GRAM || 1000),
  },
};

module.exports = { config, PLAUSIBLE_PER_GRAM };
