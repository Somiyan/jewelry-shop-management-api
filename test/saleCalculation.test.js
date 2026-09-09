const test = require('node:test');
const assert = require('node:assert');
const { determineIsInterState, splitGst } = require('../src/services/pricingService');

test('same state is intra-state (CGST+SGST)', () => {
  assert.strictEqual(determineIsInterState('Maharashtra', 'Maharashtra'), false);
  assert.strictEqual(determineIsInterState('maharashtra', 'MAHARASHTRA  '), false); // case/whitespace insensitive
});

test('different state is inter-state (IGST)', () => {
  assert.strictEqual(determineIsInterState('Maharashtra', 'Gujarat'), true);
});

test('a customer with no state on file defaults to intra-state, not IGST', () => {
  assert.strictEqual(determineIsInterState('Maharashtra', ''), false);
  assert.strictEqual(determineIsInterState('Maharashtra', undefined), false);
});

test('splitGst: intra-state splits evenly into CGST+SGST, no IGST', () => {
  const split = splitGst(1800, false);
  assert.strictEqual(split.cgstAmount, 900);
  assert.strictEqual(split.sgstAmount, 900);
  assert.strictEqual(split.igstAmount, 0);
});

test('splitGst: inter-state is IGST in full, no CGST/SGST', () => {
  const split = splitGst(1800, true);
  assert.strictEqual(split.igstAmount, 1800);
  assert.strictEqual(split.cgstAmount, 0);
  assert.strictEqual(split.sgstAmount, 0);
});

test('splitGst: an odd-paisa total does not lose or duplicate money on the split', () => {
  const split = splitGst(100.01, false);
  assert.strictEqual(Math.round((split.cgstAmount + split.sgstAmount) * 100) / 100, 100.01);
});
