import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import '../src/tools.mjs';
import { modelAllowed } from '../src/model-aliases.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

test('modelAllowed matches aliases, families and ids', () => {
  const env = {};
  assert.equal(modelAllowed('anything', null), true);
  assert.equal(modelAllowed('default', ['haiku']), true);
  assert.equal(modelAllowed('sonnet', ['sonnet', 'haiku'], { env }), true);
  assert.equal(modelAllowed('claude-sonnet-5-5', ['sonnet'], { env }), true);
  assert.equal(modelAllowed('opus', ['sonnet', 'haiku'], { env }), false);
  assert.equal(modelAllowed('opus', ['claude-opus-5-5'], { env }), true);
  assert.equal(modelAllowed('gpt-5', ['gpt-5', 'sonnet'], { env }), true);
  assert.equal(modelAllowed('gpt-4o', ['gpt-5'], { env }), false);
});

test('availableModels restricts /model, /advisor and the startup model', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-avail-'));
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false }, availableModels: ['sonnet', 'haiku'] };
  const session = await createSession({ root, config: { ...config, model: 'opus' }, settings, env: { ...process.env, HOME: root } });
  t.after(() => closeSession(session));
  assert.equal(session.config.model, 'sonnet');
  assert.match(session.modelRestrictionNote, /not in availableModels/);
  const blocked = await runBuiltinCommand('model', 'opus', { session, sessionOptions: {}, env: process.env });
  assert.match(blocked.output, /not in availableModels/);
  assert.equal(session.config.model, 'sonnet');
  const ok = await runBuiltinCommand('model', 'haiku', { session, sessionOptions: {}, env: process.env });
  assert.match(ok.output, /set to haiku/);
  const advisor = await runBuiltinCommand('advisor', 'opus', { session, sessionOptions: {}, env: process.env });
  assert.match(advisor.output, /not in availableModels/);
  assert.equal(session.advisorModel ?? null, null);
});
