import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

// Seen live: the user denied `npm test` and asked the agent to read the test
// file instead; it answered, then a "you described the work" nudge told it to
// edit files, and it ended with "I'm unable to determine which change...".
test('after the user denies a step, an explanatory answer is not nudged into edits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-denied-nudge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const { config } = await scriptedModel(t, [async (payload) => {
    calls++;
    if (!payload.messages.some((m) => m.role === 'tool')) return toolCall('c1', 'run_command', { command: 'npm', args: ['test'] });
    return { content: '`cart.test.js` contains two simple tests:\n\n1. **total test** - Calls the total function\n2. **discount test** - Calls applyDiscount' };
  }]);
  const session = await createSession({ root, config, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.cfg') } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'Run the test suite using npm test and capture the output.', { approval: async () => false });
  assert.ok(!session.messages.some((m) => m.role === 'user' && /You described the work instead of doing it/.test(String(m.content))), 'no action nudge after a denial');
  assert.equal(calls, 2);
});
