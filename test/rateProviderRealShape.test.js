const test = require('node:test');
const assert = require('node:assert');
const { normalizeRateResponse } = require('../src/integrations/rateNormalizer');

/**
 * The actual shape returned by
 * gold-silver-rates-india.p.rapidapi.com/api/Fetch-Gold-Silver/?city=mumbai
 * captured 2026-09-09. Pinned so a provider change breaks a test rather than
 * a price.
 */
const REAL = {
  success: true,
  data: {
    gold: {
      '22k': { '1gram': 14290, '8grams': 114320, '10grams': 142900 },
      '24k': { '1gram': 15005, '8grams': 120040, '10grams': 150050 },
    },
    silver: {
      '1gram': 255,
      '1kg': 255000,
      '08sep2026': 2550,
      '07sep2026': 2550,
      '03sep2026': 2555,
      andhrapradesh: 0,
      maharashtra: 0,
      westbengal: 0,
    },
  },
};

test('reads the pure 24K gold rate, not the 22K one', () => {
  const result = normalizeRateResponse(REAL, { city: 'mumbai' });
  assert.strictEqual(result.gold.ratePerGram, 15005);
  assert.strictEqual(result.gold.purityToken, '24k');
});

test('reads silver per gram, not the per-kilogram figure', () => {
  const result = normalizeRateResponse(REAL, { city: 'mumbai' });
  assert.strictEqual(result.silver.ratePerGram, 255);
});

test('every quoted gold quantity reduces to the same per-gram rate', () => {
  // Guards against the provider reordering its keys: 1gram, 8grams and
  // 10grams must all normalize identically, so whichever is seen first wins
  // without changing the answer.
  const perQuantity = ['1gram', '8grams', '10grams'].map((key) => {
    const payload = {
      data: { gold: { '24k': { [key]: REAL.data.gold['24k'][key] } }, silver: { '1gram': 255 } },
    };
    return normalizeRateResponse(payload).gold.ratePerGram;
  });
  assert.deepStrictEqual(perQuantity, [15005, 15005, 15005]);
});

test('ignores the zero-valued state list and dated history rows', () => {
  const result = normalizeRateResponse(REAL, { city: 'mumbai' });
  // 2550 (a dated row) and 0 (state placeholders) must never be chosen.
  assert.notStrictEqual(result.silver.ratePerGram, 2550);
  assert.notStrictEqual(result.silver.ratePerGram, 255000);
});

test('falls back to 22K scaled to pure when 24K is absent', () => {
  const only22k = { data: { gold: { '22k': { '1gram': 14290 } }, silver: { '1gram': 255 } } };
  const result = normalizeRateResponse(only22k);
  // 14290 / 0.916 = 15600.44 — the pure-equivalent, not the 22K figure.
  assert.ok(Math.abs(result.gold.ratePerGram - 15600.44) < 1, `got ${result.gold.ratePerGram}`);
});
