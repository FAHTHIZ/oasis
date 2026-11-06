// Token counting for context budgeting.
//
// Counts use the o200k_base BPE vocabulary through gpt-tokenizer (MIT). No single
// vocabulary matches every provider, but a real BPE count tracks code, JSON and
// non-Latin scripts far better than characters / 4, which undercounts JSON by
// ~40% and Chinese by ~60%. Where the provider reports usage, that number wins
// (see contextTokens in context.mjs); this is for text it has not seen yet.
//
// The vocabulary loads on first use (~190 ms, once per process). If it cannot be
// loaded, counting falls back to characters / 4.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OPTIONS = { disallowedSpecial: new Set() }; // "<|endoftext|>" in a file is just text
const CHUNK = 8192; // long unbroken runs (base64, minified code) stay linear when chunked
let bpe;

function counter() {
  if (bpe === undefined) {
    try { bpe = require('gpt-tokenizer/encoding/o200k_base').countTokens; }
    catch { bpe = null; }
  }
  return bpe;
}

export function countTextTokens(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (!value) return 0;
  const count = counter();
  if (!count) return Math.ceil(value.length / 4);
  if (value.length <= CHUNK * 2) return count(value, OPTIONS);
  let total = 0;
  for (let i = 0; i < value.length; i += CHUNK) total += count(value.slice(i, i + CHUNK), OPTIONS);
  return total;
}

// Token count of a JSON-serializable value (tool schemas, structured content).
export function countJsonTokens(value) {
  try { return countTextTokens(JSON.stringify(value) || ''); }
  catch { return 0; }
}
