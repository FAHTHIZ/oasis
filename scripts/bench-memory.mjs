#!/usr/bin/env node
// Memory retrieval benchmark: recall@1, recall@3 and MRR of rankMemories on a
// fixed set of project memories and paraphrased questions. "dev" queries may
// be used while tuning; "heldout" queries are the number to report.
//   node scripts/bench-memory.mjs [--json]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankMemories } from '../src/auto-memory.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'memory-retrieval');

export async function memoryRetrievalScores() {
  const memories = JSON.parse(await readFile(path.join(DIR, 'memories.json'), 'utf8'))
    .map((item) => ({ ...item, updated: '2026-01-01T00:00:00.000Z', recalls: 0 }));
  const queries = JSON.parse(await readFile(path.join(DIR, 'queries.json'), 'utf8'));
  const out = {};
  for (const [split, list] of Object.entries(queries)) {
    let r1 = 0, r3 = 0, rr = 0;
    const misses = [];
    for (const { q, want } of list) {
      const ranked = rankMemories(memories, q, { limit: 10 }).map((hit) => hit.memory.key);
      const rank = ranked.indexOf(want) + 1;
      if (rank === 1) r1 += 1;
      if (rank && rank <= 3) r3 += 1;
      if (rank) rr += 1 / rank;
      if (rank !== 1) misses.push({ q, want, got: ranked.slice(0, 3), rank: rank || null });
    }
    out[split] = { queries: list.length, recallAt1: r1 / list.length, recallAt3: r3 / list.length, mrr: rr / list.length, misses };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scores = await memoryRetrievalScores();
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(scores, null, 2) + '\n');
  else for (const [split, s] of Object.entries(scores)) {
    process.stdout.write(split + ': recall@1 ' + (s.recallAt1 * 100).toFixed(0) + '%  recall@3 ' + (s.recallAt3 * 100).toFixed(0) + '%  MRR ' + s.mrr.toFixed(3) + '  (' + s.queries + ' queries)\n');
    for (const miss of s.misses) process.stdout.write('  miss: "' + miss.q + '" want ' + miss.want + ' rank ' + miss.rank + ' got ' + miss.got.join(', ') + '\n');
  }
}
