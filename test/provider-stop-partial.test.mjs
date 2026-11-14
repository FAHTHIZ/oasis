import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

// A content filter that stops a reply part-way used to return the half answer
// as if it were complete.
test('text cut by a provider content filter is shown with a note that it may be incomplete', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-provider-cut-'));
  const model = await scriptedModel(t, [{ content: 'The first half of the answer', finish_reason: 'content_filter' }]);
  const session = await createSession({ root, config: model.config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const result = await runAgentTurn(session, 'Explain something.', { onDelta() {}, onText() {} });
  assert.match(result.text, /^The first half of the answer\n\n\(The provider stopped this reply before it finished: finish reason content_filter\. It may be incomplete\.\)$/);
  assert.equal(model.requests.length, 1);
});

test('a normal stop is not annotated', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-provider-cut-'));
  const model = await scriptedModel(t, [{ content: 'Whole answer.', finish_reason: 'stop' }]);
  const session = await createSession({ root, config: model.config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const result = await runAgentTurn(session, 'Explain something.', { onDelta() {}, onText() {} });
  assert.equal(result.text, 'Whole answer.');
});
