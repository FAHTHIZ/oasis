// In the terminal, `oasis connect http://127.0.0.1:9/v1` said "does it allow
// browser apps? (Ollama: OLLAMA_ORIGINS=* ollama serve)": CORS advice that
// only applies to the browser app. Outside a browser the hint is about the
// server itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { smartConnect } from '../app/core/connect.mjs';

const dead = async () => { throw new TypeError('fetch failed'); };

test('connect failures outside a browser do not give CORS advice', async () => {
  for (const input of ['http://127.0.0.1:9/v1', 'https://models.example.test/v1', 'ollama']) {
    await assert.rejects(smartConnect(input, { fetchImpl: dead, tries: 1, retryDelayMs: 0, probeTimeoutMs: 50 }), (error) => {
      assert.doesNotMatch(error.message, /browser apps|CORS|OLLAMA_ORIGINS/, input + ': ' + error.message);
      return true;
    });
  }
});
