import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import '../src/tools.mjs';
import { modelAllowed, modelDenied, applyModelOverride } from '../src/model-aliases.mjs';
import { loadSettings } from '../src/settings.mjs';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const env = {};

test('deniedModels blocks families, every spelling of a version, and later minors', () => {
  assert.equal(modelDenied('claude-haiku-4-5', ['haiku'], { env }), true);
  assert.equal(modelDenied('claude-opus-4-6', ['claude-opus-4.6'], { env }), true);
  assert.equal(modelDenied('us.anthropic.claude-opus-4-6-v1:0', ['claude-opus-4-6'], { env }), true);
  assert.equal(modelDenied('claude-opus-4-6-20260101', ['claude-opus-4-6'], { env }), true);
  assert.equal(modelDenied('claude-opus-5-5', ['claude-opus-5'], { env }), true);
  assert.equal(modelDenied('claude-opus-5-5', ['claude-opus-5-0'], { env }), false);
  assert.equal(modelDenied('claude-opus-5', ['claude-opus-5-0'], { env }), true);
  assert.equal(modelDenied('claude-sonnet-5-5', ['claude-opus-5'], { env }), false);
  assert.equal(modelDenied('claude-opus-5-5', ['best', 'opusplan', 'default'], { env }), false);
  // Applies with no availableModels list at all.
  assert.equal(modelAllowed('claude-haiku-4-5', null, { env, denied: ['haiku'] }), false);
  assert.equal(modelAllowed('gpt-5', null, { env, denied: ['haiku'] }), true);
});

test('availableModelsMatch prefix (default) and exact', () => {
  assert.equal(modelAllowed('claude-opus-5-5', ['claude-opus-5'], { env }), true);
  assert.equal(modelAllowed('claude-opus-5-5', ['claude-opus-5'], { env, match: 'exact' }), false);
  assert.equal(modelAllowed('claude-opus-4-5-20251101', ['claude-opus-4-5'], { env, match: 'exact' }), true);
  assert.equal(modelAllowed('claude-opus-4.5', ['claude-opus-4-5'], { env, match: 'exact' }), true);
  assert.equal(modelAllowed('gpt-5-mini', ['gpt-5'], { env }), true);
  assert.equal(modelAllowed('gpt-4o', ['gpt-5'], { env }), false);
});

test('modelOverrides maps a resolved id to the provider id', () => {
  assert.equal(applyModelOverride('claude-opus-4-6', { 'claude-opus-4-6': 'arn:aws:bedrock:x' }), 'arn:aws:bedrock:x');
  assert.equal(applyModelOverride('claude-opus-4-6-20260101', { 'claude-opus-4.6': 'gw-opus' }), 'gw-opus');
  assert.equal(applyModelOverride('gpt-5', { 'claude-opus-4-6': 'x' }), 'gpt-5');
});

test('deniedModels and availableModelsMatch are read from managed settings only; modelOverrides from trusted files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-modelpol-'));
  const home = path.join(root, 'home');
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await mkdir(home, { recursive: true });
  const managed = path.join(root, 'managed.json');
  await writeFile(managed, JSON.stringify({ deniedModels: ['haiku'], availableModelsMatch: 'exact' }));
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ deniedModels: ['opus'], availableModelsMatch: 'prefix', modelOverrides: { 'claude-opus-4-6': 'proj-id' } }));
  const base = { OASIS_CONFIG_DIR: home, HOME: home, CLAUDE_CONFIG_DIR: home, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: managed };
  const trusted = await loadSettings(root, { env: { ...base, OASIS_TRUST_WORKSPACE: '1' } });
  assert.deepEqual(trusted.deniedModels, ['haiku']);
  assert.equal(trusted.availableModelsMatch, 'exact');
  assert.deepEqual(trusted.modelOverrides, { 'claude-opus-4-6': 'proj-id' });
  const untrusted = await loadSettings(root, { env: base });
  assert.equal(untrusted.modelOverrides, undefined);
});

test('a denied model falls back at startup, is refused by /model, and overrides reach the provider', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-modelpol-'));
  const { config, requests } = await scriptedModel(t, [{ content: 'ok' }]);
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false }, availableModels: ['claude-haiku-4-5', 'claude-sonnet-5-5'], deniedModels: ['haiku'], modelOverrides: { 'claude-sonnet-5-5': 'gateway-sonnet' } };
  const session = await createSession({ root, config: { ...config, model: 'claude-haiku-4-5' }, settings, env: { ...process.env, HOME: root } });
  t.after(() => closeSession(session));
  assert.equal(session.config.model, 'claude-sonnet-5-5');
  assert.match(session.modelRestrictionNote, /blocked by deniedModels/);
  const blocked = await runBuiltinCommand('model', 'claude-haiku-4-5', { session, sessionOptions: {}, env: process.env });
  assert.match(blocked.output, /deniedModels/);
  assert.equal(session.config.model, 'claude-sonnet-5-5');
  await runAgentTurn(session, 'hi');
  assert.equal(requests[0].model, 'gateway-sonnet');
});
