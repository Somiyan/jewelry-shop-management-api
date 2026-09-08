const test = require('node:test');
const assert = require('node:assert');

process.env.RAPIDAPI_KEY = 'test-secret-key-value';
process.env.RATE_PROVIDER_MAX_ATTEMPTS = '3';
process.env.RATE_PROVIDER_RETRY_DELAY_MS = '1';
process.env.RATE_PROVIDER_TIMEOUT_MS = '50';

const { fetchLiveRates, redact, isRetryableStatus } = require('../src/integrations/rateProviderClient');

const GOOD_BODY = JSON.stringify({ gold: { '24k': { gram: 7500 } }, silver: { '999': { gram: 92 } } });
const realFetch = globalThis.fetch;

function stubFetch(impl) {
  globalThis.fetch = impl;
  return () => { globalThis.fetch = realFetch; };
}

test('returns normalized rates on a successful response', async () => {
  const restore = stubFetch(async () => ({ ok: true, status: 200, text: async () => GOOD_BODY }));
  try {
    const result = await fetchLiveRates({ city: 'mumbai' });
    assert.strictEqual(result.gold.ratePerGram, 7500);
    assert.strictEqual(result.attempts, 1);
  } finally { restore(); }
});

test('sends the key as a header and never in the URL', async () => {
  let seenUrl = null; let seenHeaders = null;
  const restore = stubFetch(async (url, init) => {
    seenUrl = String(url); seenHeaders = init.headers;
    return { ok: true, status: 200, text: async () => GOOD_BODY };
  });
  try {
    await fetchLiveRates({ city: 'mumbai' });
    assert.ok(!seenUrl.includes('test-secret-key-value'), 'key must not appear in the URL');
    assert.strictEqual(seenHeaders['x-rapidapi-key'], 'test-secret-key-value');
    assert.ok(seenUrl.includes('city=mumbai'));
  } finally { restore(); }
});

test('does NOT retry a 4xx', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { ok: false, status: 403, text: async () => 'forbidden' }; });
  try {
    await assert.rejects(fetchLiveRates(), /403/);
    assert.strictEqual(calls, 1, 'a client error should not be retried');
  } finally { restore(); }
});

test('retries a 5xx up to the configured limit, then fails', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { ok: false, status: 503, text: async () => 'upstream down' }; });
  try {
    await assert.rejects(fetchLiveRates(), /503/);
    assert.strictEqual(calls, 3, 'should stop after RATE_PROVIDER_MAX_ATTEMPTS');
  } finally { restore(); }
});

test('recovers when a retry succeeds', async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => GOOD_BODY };
  });
  try {
    const result = await fetchLiveRates();
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.gold.ratePerGram, 7500);
  } finally { restore(); }
});

test('times out a hanging provider', async () => {
  const restore = stubFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
  }));
  try {
    await assert.rejects(fetchLiveRates(), /timed out/);
  } finally { restore(); }
});

test('rejects a non-JSON response without retrying', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { ok: true, status: 200, text: async () => '<html>maintenance</html>' }; });
  try {
    await assert.rejects(fetchLiveRates(), /non-JSON/);
    assert.strictEqual(calls, 1);
  } finally { restore(); }
});

test('rejects a valid response that carries no usable rate', async () => {
  const restore = stubFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ note: 'closed today' }) }));
  try {
    await assert.rejects(fetchLiveRates(), /no numeric rate values|no usable/);
  } finally { restore(); }
});

test('refuses to call out when no key is configured', async () => {
  const saved = process.env.RAPIDAPI_KEY;
  process.env.RAPIDAPI_KEY = '';
  try {
    await assert.rejects(fetchLiveRates(), /RAPIDAPI_KEY is not configured/);
  } finally { process.env.RAPIDAPI_KEY = saved; }
});

test('never leaks the key into an error message', async () => {
  const restore = stubFetch(async () => ({
    ok: false, status: 401,
    text: async () => 'Invalid key test-secret-key-value supplied via x-rapidapi-key: test-secret-key-value',
  }));
  try {
    await fetchLiveRates();
    assert.fail('expected rejection');
  } catch (err) {
    assert.ok(!err.message.includes('test-secret-key-value'), `key leaked: ${err.message}`);
    assert.ok(err.message.includes('REDACTED'));
  } finally { restore(); }
});

test('redact scrubs the key and header form', () => {
  assert.ok(!redact('key=test-secret-key-value').includes('test-secret-key-value'));
  assert.ok(!redact('x-rapidapi-key: abc123').includes('abc123'));
});

test('classifies which statuses are worth retrying', () => {
  assert.strictEqual(isRetryableStatus(500), true);
  assert.strictEqual(isRetryableStatus(429), true);
  assert.strictEqual(isRetryableStatus(408), true);
  assert.strictEqual(isRetryableStatus(404), false);
  assert.strictEqual(isRetryableStatus(401), false);
});
