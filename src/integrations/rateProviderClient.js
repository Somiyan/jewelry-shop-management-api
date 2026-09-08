const { config } = require('../config/rateProvider');
const { normalizeRateResponse } = require('./rateNormalizer');

/**
 * HTTP client for the RapidAPI gold/silver feed.
 *
 * Uses Node's built-in fetch (Node 18+) rather than adding an HTTP dependency,
 * since this is the only outbound call the backend makes.
 */

class RateProviderError extends Error {
  constructor(message, { status = null, attempts = 0, retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'RateProviderError';
    this.status = status;
    this.attempts = attempts;
    this.retryable = retryable;
    this.cause = cause;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 408/429 and 5xx are worth another go; other 4xx are our fault, not theirs. */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Removes anything secret from text that may end up in a log or API response.
 * The key should never reach here, but a provider echoing headers back would
 * otherwise leak it into our logs.
 */
function redact(text) {
  if (!text) return text;
  const key = config.key;
  let safe = String(text);
  if (key) safe = safe.split(key).join('***REDACTED***');
  return safe.replace(/(x-rapidapi-key\s*[:=]\s*)[^\s,"']+/gi, '$1***REDACTED***');
}

/** One HTTP attempt, with a hard timeout. */
async function requestOnce(city) {
  const url = new URL(config.url);
  url.searchParams.set('city', city);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': config.host,
        'x-rapidapi-key': config.key,
      },
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new RateProviderError(
        `Rate provider responded ${response.status}: ${redact(text).slice(0, 200)}`,
        { status: response.status, retryable: isRetryableStatus(response.status) }
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new RateProviderError('Rate provider returned a non-JSON response', {
        status: response.status,
        retryable: false,
      });
    }
  } catch (err) {
    if (err instanceof RateProviderError) throw err;
    if (err.name === 'AbortError') {
      throw new RateProviderError(`Rate provider timed out after ${config.timeoutMs}ms`, {
        retryable: true,
        cause: err,
      });
    }
    // DNS failures, socket resets and the like — transient by nature.
    throw new RateProviderError(`Rate provider request failed: ${redact(err.message)}`, {
      retryable: true,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches and normalizes the current rates. Retries only failures that could
 * plausibly succeed next time, with a linear backoff, and gives up after
 * `RATE_PROVIDER_MAX_ATTEMPTS` rather than retrying indefinitely.
 *
 * Never writes to the database — callers decide whether to store the result.
 */
async function fetchLiveRates({ city = config.city } = {}) {
  if (!config.isConfigured()) {
    throw new RateProviderError(
      'Live rates are not available: RAPIDAPI_KEY is not configured on the server',
      { retryable: false }
    );
  }

  const attempts = Math.max(1, config.maxAttempts);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const payload = await requestOnce(city);
      const normalized = normalizeRateResponse(payload, { city });

      if (!normalized.gold && !normalized.silver) {
        throw new RateProviderError(
          'Rate provider response contained no usable gold or silver rate',
          { retryable: false }
        );
      }

      return { ...normalized, attempts: attempt, rawPayload: payload };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof RateProviderError ? err.retryable : false;
      if (!retryable || attempt === attempts) break;
      console.warn(
        `[rates] attempt ${attempt}/${attempts} failed (${err.message}); retrying in ${config.retryDelayMs}ms`
      );
      await wait(config.retryDelayMs * attempt);
    }
  }

  throw new RateProviderError(redact(lastError ? lastError.message : 'Unknown rate provider failure'), {
    status: lastError && lastError.status,
    attempts,
    retryable: false,
    cause: lastError,
  });
}

module.exports = { fetchLiveRates, RateProviderError, redact, isRetryableStatus };
