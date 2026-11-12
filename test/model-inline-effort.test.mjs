import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import '../src/tools.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

test('/model NAME EFFORT switches the model and sets reasoning effort', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-model-effort-'));
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const session = await createSession({ root, config: { ...config, model: 'gpt-5' }, settings, env: { ...process.env, HOME: root } });
  t.after(() => closeSession(session));
  const sessionOptions = {};
  const switched = await runBuiltinCommand('model', 'gpt-5-mini high', { session, sessionOptions, env: process.env });
  assert.match(switched.output, /Model set to gpt-5-mini\. Reasoning effort: high\./);
  assert.equal(session.config.model, 'gpt-5-mini');
  assert.equal(sessionOptions.effort, 'high');
  const same = await runBuiltinCommand('model', 'gpt-5-mini low', { session, sessionOptions, env: process.env });
  assert.match(same.output, /already gpt-5-mini\. Reasoning effort: low\./);
  assert.equal(sessionOptions.effort, 'low');
  // A second word that is not an effort level stays part of the model name.
  const odd = await runBuiltinCommand('model', 'my model', { session, sessionOptions, env: process.env });
  assert.match(odd.output, /my model/);
  assert.equal(sessionOptions.effort, 'low');
});
