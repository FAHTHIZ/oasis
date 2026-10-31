import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession, inlineEffortLevel, stripInlineEffort } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

test('inline effort tokens are parsed and stripped', () => {
  assert.equal(inlineEffortLevel('fix the bug effort:high'), 'high');
  assert.equal(inlineEffortLevel('effort:LOW quick rename'), 'low');
  assert.equal(inlineEffortLevel('effort:max.'), 'max');
  assert.equal(inlineEffortLevel('set effort:huge'), null);
  assert.equal(inlineEffortLevel('noeffort:high'), null);
  assert.equal(stripInlineEffort('fix the bug effort:high'), 'fix the bug');
  assert.equal(stripInlineEffort('effort:low rename x'), 'rename x');
});

test('effort:LEVEL applies to one turn only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-effort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'done' }]);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_REASONING_EFFORT: '', OASIS_THINKING: '' };
  const session = await createSession({ root, config: { ...config, model: 'gpt-5-mini' }, env });
  t.after(() => closeSession(session));
  let seen = null;
  await runAgentTurn(session, 'rename the helper effort:low', { env, onInlineEffort: (level) => { seen = level; } });
  assert.equal(seen, 'low');
  assert.equal(requests[0].reasoning_effort, 'low');
  const user = requests[0].messages.filter((m) => m.role === 'user').at(-1);
  assert.doesNotMatch(String(user.content), /effort:low/);
  await runAgentTurn(session, 'now explain it', { env });
  assert.equal(requests[1].reasoning_effort, undefined);
  assert.equal(session.config.reasoningEffort, undefined);
});
