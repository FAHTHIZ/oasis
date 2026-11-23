// Claim conflicts: do two findings about the same thing disagree?
//
// Word-overlap duplicate detection treats "the API allows 500 requests per
// minute" and "the API allows 1000 requests per minute" as the same finding,
// because they share every word but the number, and so a contradiction would
// be counted as corroboration. Multi-agent systems that merge by similarity
// (or by an LLM summarizer) hide disagreements the same way. This module finds
// the disagreement instead:
//
//   numbers   the claims are about the same thing (≥ 0.6 word overlap with
//             numbers removed) but state different figures; differing years
//             mean different periods, not a conflict
//   negation  the same statement, one with "not", "never", "no", "cannot"...
//   polarity  the same statement with one opposite word swapped
//             (increased/decreased, supports/deprecated, enabled/disabled...)
//
// The result is a short human reason ("500 vs 1000"), or null.

import { tokenize } from './auto-memory.mjs';

const SAME_TOPIC = 0.6;
const NEGATIONS = /\b(?:not|no|never|none|cannot|without|neither|nor|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|can't|couldn't|shouldn't|hasn't|haven't|hadn't|unsupported|unavailable)\b|n't\b/gi;
const OPPOSITES = [
  ['increase', 'decrease'], ['increased', 'decreased'], ['increases', 'decreases'], ['rise', 'fall'], ['rose', 'fell'], ['rises', 'falls'],
  ['grew', 'shrank'], ['higher', 'lower'], ['more', 'fewer'], ['more', 'less'], ['above', 'below'], ['faster', 'slower'], ['larger', 'smaller'],
  ['gain', 'loss'], ['profit', 'loss'], ['up', 'down'], ['before', 'after'], ['true', 'false'], ['valid', 'invalid'],
  ['enabled', 'disabled'], ['enable', 'disable'], ['allowed', 'blocked'], ['allows', 'blocks'], ['allows', 'forbids'], ['supported', 'deprecated'],
  ['supports', 'deprecates'], ['added', 'removed'], ['adds', 'removes'], ['passed', 'failed'], ['passes', 'fails'], ['succeeded', 'failed'],
  ['safe', 'unsafe'], ['public', 'private'], ['required', 'optional'], ['synchronous', 'asynchronous'], ['sync', 'async'], ['win', 'lose'], ['won', 'lost'],
  ['approved', 'rejected'], ['accepted', 'rejected'], ['confirmed', 'denied'], ['legal', 'illegal'], ['included', 'excluded'], ['open', 'closed']
];
const OPPOSITE = new Map();
for (const [a, b] of OPPOSITES) {
  if (!OPPOSITE.has(a)) OPPOSITE.set(a, new Set());
  if (!OPPOSITE.has(b)) OPPOSITE.set(b, new Set());
  OPPOSITE.get(a).add(b);
  OPPOSITE.get(b).add(a);
}
const NUMBER = /(?<![\p{L}\d.])[-+−]?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|percent|k|m|bn|million|billion|thousand)(?![\p{L}]))?/giu;
const VERSION = /\bv?\d+\.\d+\.\d+\b/g;
const YEAR = /^(1[89]\d\d|20\d\d)$/;
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

/** The figures a claim states, normalized ("1,000" and "1k" are both 1000; versions as "v1.2.3"). Years are kept apart. */
export function claimNumbers(text) {
  const values = new Set();
  for (const match of String(text || '').matchAll(VERSION)) values.add('v' + match[0].replace(/^v/i, ''));
  const plain = String(text || '').replace(VERSION, ' ');
  const years = new Set();
  for (const match of plain.matchAll(NUMBER)) {
    const raw = match[0].replace(/\s+/g, '').toLowerCase();
    const unit = (raw.match(/(%|percent|k|m|bn|million|billion|thousand)$/) || [''])[0];
    const digits = raw.slice(0, raw.length - unit.length).replace(/,/g, '').replace('−', '-');
    const number = Number(digits);
    if (!Number.isFinite(number)) continue;
    if (!unit && YEAR.test(digits)) { years.add(digits); continue; }
    const value = unit === '%' || unit === 'percent' ? number + '%' : String(number * (SCALE[unit] || 1));
    values.add(value);
  }
  return { values, years };
}

function wordsOf(text) {
  return String(text || '').toLowerCase().replace(VERSION, ' ').match(/[\p{L}]+(?:'[\p{L}]+)?/gu) || [];
}

function negations(text) {
  return (String(text || '').match(NEGATIONS) || []).length;
}

/** Word overlap of two claims with numbers, negations and opposite words ignored. */
export function topicSimilarity(a, b) {
  const strip = (text) => new Set(tokenize(String(text || '').replace(NUMBER, ' ').replace(NEGATIONS, ' ').replace(/[\p{L}]+/gu, (word) => (OPPOSITE.has(word.toLowerCase()) ? ' ' : word))).filter((term) => !/^\d/.test(term)));
  const left = strip(a);
  const right = strip(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

/**
 * Why claims a and b contradict each other, or null. `threshold` is the topic
 * overlap above which they are about the same thing.
 */
export function claimConflict(a, b, { threshold = SAME_TOPIC } = {}) {
  const topic = topicSimilarity(a, b);
  if (topic < threshold) return null;
  const left = claimNumbers(a);
  const right = claimNumbers(b);
  // Different years: probably the same measure at different times, not a dispute.
  const yearsDiffer = left.years.size && right.years.size && !sameSet(left.years, right.years);
  if (!yearsDiffer && left.values.size && right.values.size && !sameSet(left.values, right.values)) {
    const onlyLeft = [...left.values].filter((value) => !right.values.has(value));
    const onlyRight = [...right.values].filter((value) => !left.values.has(value));
    if (onlyLeft.length && onlyRight.length) return { kind: 'numbers', reason: onlyLeft.slice(0, 3).join(', ') + ' vs ' + onlyRight.slice(0, 3).join(', '), topic };
  }
  if ((negations(a) > 0) !== (negations(b) > 0)) return { kind: 'negation', reason: 'one says the opposite (' + (negations(a) ? 'first' : 'second') + ' is negated)', topic };
  const wordsA = new Set(wordsOf(a));
  const wordsB = new Set(wordsOf(b));
  for (const word of wordsA) {
    if (wordsB.has(word)) continue;
    const opposite = OPPOSITE.get(word);
    if (!opposite) continue;
    for (const other of opposite) if (wordsB.has(other) && !wordsA.has(other)) return { kind: 'polarity', reason: '"' + word + '" vs "' + other + '"', topic };
  }
  return null;
}
