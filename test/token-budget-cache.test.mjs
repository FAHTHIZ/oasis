// The per-turn token budget leaves out cache reads: every step re-sends the
// whole conversation, and counting that cached prefix again and again stopped
// long tasks in a large context after a few steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const cachedUsage = { prompt_tokens: 9000, completion_tokens: 100, total_tokens: 9100, prompt_tokens_details: { cached_tokens: 8500 } };
const freshUsage = { prompt_tokens: 9000, completion_tokens: 100, total_tokens: 9100 };

async function run(t, usage) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'A\n');
  const { config } = await scriptedModel(t, [
    { ...toolCall('r1', 'read_file', { path: 'a.txt' }), usage },
    { ...toolCall('r2', 'list_files', {}), usage },
    { ...toolCall('r3', 'search_files', { query: 'A' }), usage },
    { content: 'All done.', usage }
  ]);
  const session = await createSession({ root, config: { ...config, maxTokens: 10000 }, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  return runAgentTurn(session, 'Look around.', { approval: async () => true });
}

test('cached prompt tokens do not use up the turn budget', async (t) => {
  const result = await run(t, cachedUsage);
  assert.equal(result.tokenLimitReached, undefined, result.text);
  assert.match(result.text, /All done/);
  assert.ok(result.tokensUsed >= 4 * 9100, 'the reported total still counts every token');
});

test('uncached tokens still stop the turn at the budget', async (t) => {
  const result = await run(t, freshUsage);
  assert.equal(result.tokenLimitReached, true);
});
