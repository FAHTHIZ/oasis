import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

async function fixture(t, script, maxSteps = 40) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cycle-'));
  await writeFile(path.join(root, 'a.txt'), 'A\n');
  await writeFile(path.join(root, 'b.txt'), 'B\n');
  const { config, requests } = await scriptedModel(t, script);
  config.maxSteps = maxSteps;
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  return { session, requests };
}

test('alternating between the same two reads is stopped as a no-progress cycle', async (t) => {
  // The consecutive-repeat check never fires on A, B, A, B: each call differs from the one before.
  const script = Array.from({ length: 60 }, (_, i) => toolCall('c' + i, 'read_file', { path: i % 2 ? 'b.txt' : 'a.txt' }));
  const { session, requests } = await fixture(t, script);
  const result = await runAgentTurn(session, 'look at the files', {});
  assert.match(result.text, /stuck/i);
  assert.ok(requests.length <= 8, 'stopped after ' + requests.length + ' requests instead of running to the step limit');
  const warned = requests.some((payload) => payload.messages.some((m) => m.role === 'tool' && /exact read_file call 3 times/.test(String(m.content))));
  assert.ok(warned, 'the model is warned once before the run is stopped');
});

test('re-issuing the same batch of calls every step is stopped', async (t) => {
  const batch = (i) => ({ content: null, tool_calls: [
    { id: 'a' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } },
    { id: 'b' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) } }
  ] });
  const { session, requests } = await fixture(t, Array.from({ length: 60 }, (_, i) => batch(i)));
  const result = await runAgentTurn(session, 'look at the files', {});
  assert.match(result.text, /stuck/i);
  assert.ok(requests.length <= 5, 'stopped after ' + requests.length + ' requests');
});

test('re-reading a file between edits is progress, not a cycle', async (t) => {
  const script = [];
  for (let i = 0; i < 6; i++) {
    script.push(toolCall('r' + i, 'read_file', { path: 'a.txt' }));
    script.push(toolCall('w' + i, 'write_file', { path: 'new-' + i + '.txt', content: 'B' + i + '\n' }));
  }
  script.push({ content: 'Finished.' });
  const { session, requests } = await fixture(t, script);
  const result = await runAgentTurn(session, 'edit the files', {});
  assert.doesNotMatch(result.text, /stuck/i);
  assert.equal(requests.length, script.length);
});
