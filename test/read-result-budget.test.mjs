// read_file results reach the model up to 100,000 characters (Claude Code's
// Read gives 25,000 tokens) instead of 24,000, bounded by the context window.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function readThrough(t, configExtra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-read-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'big.js'), Array.from({ length: 1800 }, (_, i) => '// line ' + (i + 1) + ' ' + 'x'.repeat(40)).join('\n'));
  const { config, requests } = await scriptedModel(t, [toolCall('r1', 'read_file', { path: 'big.js' }), { content: 'done' }]);
  const session = await createSession({ root, config: { ...config, ...configExtra }, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  await runAgentTurn(session, 'Read big.js.', { approval: async () => true });
  return JSON.parse(requests[1].messages.find((m) => m.role === 'tool').content);
}

test('a large file comes back in one read on a large context window', async (t) => {
  const result = await readThrough(t, { contextWindow: 200000 });
  assert.match(result.content, /\/\/ line 1800 x+$/, 'all 1,800 lines (about 90,000 characters) in one result');
});

test('a small context window still gets a line-aware cut with where to continue', async (t) => {
  const result = await readThrough(t, { contextWindow: 16000 });
  assert.ok(result.endLine < 1800);
  assert.match(result.note, /Continue with read_file offset=/);
});
