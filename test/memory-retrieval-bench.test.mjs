import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryRetrievalScores } from '../scripts/bench-memory.mjs';

// Floors for the held-out memory retrieval set (evals/memory-retrieval).
// Measured 2026-11-09: held-out recall@1 92%, recall@3 100%, MRR 0.960.
test('memory retrieval stays above its measured floor on held-out questions', async () => {
  const { heldout, dev } = await memoryRetrievalScores();
  assert.ok(heldout.recallAt1 >= 0.88, 'held-out recall@1 ' + heldout.recallAt1);
  assert.ok(heldout.recallAt3 >= 0.96, 'held-out recall@3 ' + heldout.recallAt3);
  assert.ok(heldout.mrr >= 0.93, 'held-out MRR ' + heldout.mrr);
  assert.ok(dev.recallAt1 >= 0.93, 'dev recall@1 ' + dev.recallAt1);
});
