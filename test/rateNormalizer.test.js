const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeRateResponse,
  parseNumeric,
  toPurePerGram,
} = require('../src/integrations/rateNormalizer');

test('parses currency-formatted strings', () => {
  assert.strictEqual(parseNumeric('₹7,500.50'), 7500.5);
  assert.strictEqual(parseNumeric('Rs. 92'), 92);
  assert.strictEqual(parseNumeric(7500), 7500);
  assert.strictEqual(parseNumeric('not a number'), null);
});

test('extracts gold and silver from a purity-keyed payload', () => {
  const result = normalizeRateResponse({
    city: 'mumbai',
    gold: { '24K': '7,500', '22K': '6,870', '18K': '5,625' },
    silver: { '999': '92' },
  }, { city: 'mumbai' });

  assert.strictEqual(result.gold.ratePerGram, 7500);
  assert.strictEqual(result.silver.ratePerGram, 92.09); // 92 / 0.999 -> pure
});

test('extracts from a labelled array payload', () => {
  const result = normalizeRateResponse({
    rates: [
      { metal: 'Gold', purity: '24K', price: '7500', unit: 'gram' },
      { metal: 'Silver', purity: '999', price: '92', unit: 'gram' },
    ],
  });
  assert.strictEqual(result.gold.ratePerGram, 7500);
  assert.ok(result.silver.ratePerGram > 0);
});

test('converts a per-10-gram gold quote to per gram', () => {
  const result = normalizeRateResponse({ gold_24k_10g: '75000', silver_999_1g: '92' });
  assert.strictEqual(result.gold.ratePerGram, 7500);
  assert.strictEqual(result.gold.quotedGrams, 10);
});

test('converts a per-kilogram silver quote to per gram', () => {
  const result = normalizeRateResponse({ gold: { '24k': { gram: 7500 } }, silver: { '999': { kg: 92000 } } });
  assert.strictEqual(result.silver.quotedGrams, 1000);
  assert.ok(Math.abs(result.silver.ratePerGram - 92.09) < 0.5);
});

test('scales a 22K quote up to the pure 24K rate', () => {
  // Storing 22K directly would double-apply the purity discount downstream.
  const converted = toPurePerGram({ value: 6870, purityToken: '22k', quotedGrams: 1, metal: 'gold' });
  assert.ok(Math.abs(converted.ratePerGram - 7500) < 1);
});

test('rejects an implausible rate rather than storing it', () => {
  const result = normalizeRateResponse({ gold: { '24k': { gram: 3 } }, silver: { '999': { gram: 92 } } });
  assert.strictEqual(result.gold, null);
  assert.ok(result.warnings.some((w) => /gold/i.test(w)));
});

test('ignores gold-to-silver ratio fields that name both metals', () => {
  const result = normalizeRateResponse({
    gold_silver_ratio: 81.5,
    gold: { '24k': { gram: 7500 } },
    silver: { '999': { gram: 92 } },
  });
  assert.strictEqual(result.gold.ratePerGram, 7500);
});

test('throws on a payload with no numeric values', () => {
  assert.throws(() => normalizeRateResponse({ message: 'no data' }), /no numeric rate values/);
});

test('throws on a non-object payload', () => {
  assert.throws(() => normalizeRateResponse('nope'), /non-object response/);
});

test('reads the provider timestamp when present', () => {
  const result = normalizeRateResponse({
    date: '2026-09-07T08:30:00.000Z',
    gold: { '24k': { gram: 7500 } },
    silver: { '999': { gram: 92 } },
  });
  assert.strictEqual(result.effectiveAt.toISOString(), '2026-09-07T08:30:00.000Z');
});
