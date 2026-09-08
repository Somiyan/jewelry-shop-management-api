const { PLAUSIBLE_PER_GRAM } = require('../config/rateProvider');

/**
 * Translates whatever RapidAPI returns into this application's internal rate
 * shape. This is the ONLY module that knows the provider's field names — if
 * the provider changes its response, nothing outside this file should need to.
 *
 * Two domain rules drive the whole design, and getting either wrong silently
 * misprices every item in the shop:
 *
 *  1. We store the PURE (24K / 999) per-gram rate. The pricing engine already
 *     multiplies by the item's purity percentage (netWeight x purity% x rate),
 *     so storing a 22K quote here would apply the 91.6% discount twice.
 *
 *  2. We store a PER-GRAM rate. Indian rate feeds commonly quote gold per
 *     10 grams and silver per kilogram, so the quoted unit is inferred and
 *     converted, then bounds-checked before it is allowed anywhere near the
 *     database.
 */

/** Purity token -> fraction of pure metal. Used to convert a quote up to 24K. */
const PURITY_FRACTIONS = {
  '9999': 0.9999,
  '999': 0.999,
  '995': 0.995,
  '24k': 1,
  '24ct': 1,
  '24': 1,
  '958': 0.958,
  '23k': 0.958,
  '916': 0.916,
  '22k': 0.916,
  '22ct': 0.916,
  '22': 0.916,
  '750': 0.75,
  '18k': 0.75,
  '18ct': 0.75,
  '18': 0.75,
  '925': 0.925,
  '585': 0.585,
  '14k': 0.585,
  '14': 0.585,
};

/**
 * Preference order when a feed offers several purities. Purest first: the
 * closer the quote is to pure metal, the less we have to scale it, and the
 * smaller any rounding error in the conversion becomes.
 */
const PURITY_PREFERENCE = ['9999', '999', '24k', '24ct', '24', '995', '958', '23k', '916', '22k', '22ct', '22', '925', '750', '18k', '18ct', '18', '585', '14k', '14'];

/**
 * Quantity-bearing unit patterns, matched against the path text.
 *
 * Parsed generically rather than from a fixed token list, because the feed
 * quotes the same purity at several quantities ("1gram", "8grams", "10grams")
 * and a list would silently miss one. Missing "8grams" would leave it to
 * magnitude inference, which reads 120040 as a per-10g quote and produces a
 * rate roughly 20% low — so every quantity must be understood explicitly.
 */
const UNIT_PATTERNS = [
  { re: /(\d+(?:\.\d+)?)\s*(?:kgs?|kilograms?|kilos?)(?![a-z])/i, multiplier: 1000 },
  { re: /(\d+(?:\.\d+)?)\s*(?:grams?|gms?|g)(?![a-z])/i, multiplier: 1 },
  { re: /(\d+(?:\.\d+)?)\s*(?:tolas?)(?![a-z])/i, multiplier: 11.6638 },
  { re: /(\d+(?:\.\d+)?)\s*(?:ounces?|ozs?)(?![a-z])/i, multiplier: 31.1035 },
];

/** Bare unit words carrying an implicit quantity of one. */
const BARE_UNIT_GRAMS = {
  kg: 1000,
  kilogram: 1000,
  kilo: 1000,
  tola: 11.6638,
  ounce: 31.1035,
  oz: 31.1035,
  gram: 1,
  gm: 1,
  g: 1,
};

/** Strips currency symbols, commas and spaces; returns null if not numeric. */
function parseNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[₹$,\s]/g, '').replace(/(?:rs|inr)\.?/gi, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

/** Flattens an arbitrarily nested payload into [{ path, value }] numeric leaves. */
function collectNumericLeaves(node, path = [], out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectNumericLeaves(child, path.concat(String(i)), out));
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      collectNumericLeaves(child, path.concat(key), out);
    }
    return out;
  }
  const num = parseNumeric(node);
  if (num !== null && num > 0) out.push({ path: path.join('.'), value: num });
  return out;
}

/**
 * Arrays of records like [{ metal: 'Gold', purity: '22K', price: '5,600' }]
 * lose their labels when flattened by key alone, so the sibling string values
 * of each object are folded into the path text before matching.
 */
function collectLabelledLeaves(node, path = [], out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectLabelledLeaves(child, path.concat(String(i)), out));
    return out;
  }
  if (typeof node === 'object') {
    const labels = Object.values(node)
      .filter((v) => typeof v === 'string' && parseNumeric(v) === null)
      .join(' ');
    for (const [key, child] of Object.entries(node)) {
      collectLabelledLeaves(child, path.concat(labels ? `${labels} ${key}` : key), out);
    }
    return out;
  }
  const num = parseNumeric(node);
  if (num !== null && num > 0) out.push({ path: path.join('.'), value: num });
  return out;
}

function matchToken(haystack, tokens) {
  const text = haystack.toLowerCase();
  for (const token of tokens) {
    // Word-ish boundary so "18" doesn't match inside "2018".
    const re = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(text)) return token;
  }
  return null;
}

/**
 * Infers how many grams the quoted figure covers, from the path text.
 * A quantity+unit ("8grams", "1kg") wins over a bare unit word ("gram").
 */
function inferQuotedGrams(pathText) {
  const text = String(pathText || '');
  for (const { re, multiplier } of UNIT_PATTERNS) {
    const match = text.match(re);
    if (match) {
      const quantity = Number(match[1]);
      if (Number.isFinite(quantity) && quantity > 0) return quantity * multiplier;
    }
  }
  const token = matchToken(text, Object.keys(BARE_UNIT_GRAMS).sort((a, b) => b.length - a.length));
  return token ? BARE_UNIT_GRAMS[token] : null;
}

/**
 * Converts a raw quote to a pure per-gram rate.
 *
 * The unit named in the response wins. When the response names no unit, the
 * magnitude decides: the only accepted scale is the one that lands inside the
 * plausible band for that metal, and an ambiguous or out-of-band figure is
 * rejected rather than guessed at.
 */
function toPurePerGram({ value, purityToken, quotedGrams, metal }) {
  const fraction = PURITY_FRACTIONS[purityToken] ?? 1;
  const bounds = PLAUSIBLE_PER_GRAM[metal];

  const candidates = quotedGrams
    ? [{ grams: quotedGrams, inferred: false }]
    : [1, 10, 100, 1000].map((grams) => ({ grams, inferred: true }));

  const viable = [];
  for (const { grams, inferred } of candidates) {
    const perGramAtPurity = value / grams;
    const perGramPure = perGramAtPurity / fraction;
    if (perGramPure >= bounds.min && perGramPure <= bounds.max) {
      viable.push({ perGramPure, grams, inferred });
    }
  }

  if (viable.length === 0) return null;
  // An explicit unit gives exactly one candidate. An inferred one that matches
  // several scales is genuinely ambiguous, so refuse instead of guessing.
  if (viable.length > 1) return null;

  const [chosen] = viable;
  return {
    ratePerGram: Math.round((chosen.perGramPure + Number.EPSILON) * 100) / 100,
    quotedGrams: chosen.grams,
    unitInferred: chosen.inferred,
    purityToken: purityToken || 'unknown',
    purityFraction: fraction,
  };
}

/** Picks the best quote for one metal out of all numeric leaves in the payload. */
function selectMetalRate(leaves, metal) {
  const metalAliases = metal === 'gold' ? ['gold', 'au'] : ['silver', 'ag'];
  const otherAliases = metal === 'gold' ? ['silver', 'ag'] : ['gold', 'au'];

  const candidates = leaves.filter((leaf) => {
    const hit = matchToken(leaf.path, metalAliases);
    if (!hit) return false;
    // "gold_silver_ratio"-style fields mention both metals; skip them.
    const other = matchToken(leaf.path, otherAliases);
    return !other;
  });

  if (candidates.length === 0) return null;

  const attempts = [];
  for (const purityToken of PURITY_PREFERENCE) {
    for (const leaf of candidates) {
      if (!matchToken(leaf.path, [purityToken])) continue;
      const converted = toPurePerGram({
        value: leaf.value,
        purityToken,
        quotedGrams: inferQuotedGrams(leaf.path),
        metal,
      });
      attempts.push({ leaf, purityToken });
      if (converted) return { ...converted, sourcePath: leaf.path, rawValue: leaf.value };
    }
  }

  // No purity label anywhere — treat the quote as pure metal and let the
  // plausibility band decide whether it is usable.
  for (const leaf of candidates) {
    const converted = toPurePerGram({
      value: leaf.value,
      purityToken: null,
      quotedGrams: inferQuotedGrams(leaf.path),
      metal,
    });
    attempts.push({ leaf, purityToken: null });
    if (converted) return { ...converted, sourcePath: leaf.path, rawValue: leaf.value };
  }

  return null;
}

/** Best-effort extraction of the provider's own timestamp. */
function extractEffectiveAt(payload) {
  const stack = [payload];
  const dateKey = /(date|time|updated|timestamp|as_?on)/i;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      } else if (dateKey.test(key) && (typeof value === 'string' || typeof value === 'number')) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
    }
  }
  return null;
}

/**
 * @returns {{ gold, silver, effectiveAt, warnings, providerMeta }}
 *          `gold`/`silver` are null when the payload carried no usable quote.
 * @throws  when the payload is not an object at all.
 */
function normalizeRateResponse(payload, { city } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Rate provider returned a non-object response');
  }

  // Both traversals are merged so labelled-array payloads and key-nested
  // payloads are handled without knowing which one the provider uses.
  const leaves = [...collectLabelledLeaves(payload), ...collectNumericLeaves(payload)];
  if (leaves.length === 0) {
    throw new Error('Rate provider response contained no numeric rate values');
  }

  const gold = selectMetalRate(leaves, 'gold');
  const silver = selectMetalRate(leaves, 'silver');

  const warnings = [];
  if (!gold) warnings.push('No plausible gold rate found in provider response');
  if (!silver) warnings.push('No plausible silver rate found in provider response');
  if (gold && gold.unitInferred) warnings.push(`Gold unit not stated by provider; inferred as per-${gold.quotedGrams}g`);
  if (silver && silver.unitInferred) warnings.push(`Silver unit not stated by provider; inferred as per-${silver.quotedGrams}g`);

  return {
    gold,
    silver,
    effectiveAt: extractEffectiveAt(payload) || new Date(),
    city: city || null,
    warnings,
  };
}

module.exports = {
  normalizeRateResponse,
  // exported for tests
  parseNumeric,
  toPurePerGram,
  selectMetalRate,
  collectNumericLeaves,
  collectLabelledLeaves,
  PURITY_FRACTIONS,
};
