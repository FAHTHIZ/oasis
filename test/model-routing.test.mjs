import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { classifyTask, selectTaskModel, sanitizeModelRouting } from '../src/model-routing.mjs';
import { createUsageTracker, recordUsage, runBuiltinCommand } from '../src/slash.mjs';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { loadSettings, updateUserSettings } from '../src/settings.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-model-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('only short, clearly read-only requests qualify for the cheaper model', () => {
  assert.deepEqual(classifyTask('Summarize the README in three bullets.'), {
    tier: 'easy',
    reason: 'short, clearly read-only request'
  });
  assert.equal(classifyTask('Explain what src/agent.mjs does.').tier, 'easy');
  assert.equal(classifyTask('Fix the authentication bug and add regression tests.').tier, 'strong');
  assert.equal(classifyTask('Review the permission checks for a security issue.').tier, 'strong');
  assert.equal(classifyTask('Make this application production-ready.').tier, 'strong');
  assert.equal(classifyTask('Tell me everything about this 400-file repository.').tier, 'strong');
});

test('model selection keeps hard and ambiguous work on the configured strong model', () => {
  const routing = { enabled: true, easyModel: 'cheap-model', strongModel: 'strong-model' };
  assert.equal(selectTaskModel('Find the definition of runWorkspaceCommand.', 'default-model', routing).model, 'cheap-model');
  assert.equal(selectTaskModel('Implement a new provider and write tests.', 'default-model', routing).model, 'strong-model');
  assert.equal(selectTaskModel('Summarize the README.', 'default-model', { ...routing, enabled: false }).model, 'default-model');
  assert.equal(selectTaskModel('Summarize the README.', 'default-model', { enabled: true }).model, 'default-model');
});

test('routing settings are strictly bounded and untrusted project routing is ignored', async (t) => {
  assert.deepEqual(sanitizeModelRouting({
    enabled: true,
    easyModel: ' cheap-model\nignore ',
    strongModel: 'strong-model'
  }), {
    enabled: true,
    easyModel: 'cheap-modelignore',
    strongModel: 'strong-model'
  });
  assert.equal(sanitizeModelRouting({ enabled: 'yes', easyModel: ['bad'] }).enabled, false);

  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, '.oasis'));
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({
    modelRouting: { enabled: true, easyModel: 'untrusted-cheap-model', strongModel: 'untrusted-strong-model' }
  }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
  const settings = await loadSettings(root, { env });
  assert.equal(settings.modelRouting.enabled, false);
  assert.ok(settings.ignoredUntrusted.includes(path.join(root, '.oasis', 'settings.json')));
});

test('user can configure model routing with slash commands and /usage reports savings', async (t) => {
  const root = await temporaryDirectory(t);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
  const session = {
    root,
    config: { model: 'strong-model', protocol: 'openai-compatible', baseURL: 'https://api.example.test/v1' },
    settings: { modelRouting: { enabled: false, easyModel: '', strongModel: '' } },
    availableModels: null
  };
  const state = { root, session, env, sessionOptions: {} };

  const easy = await runBuiltinCommand('routing', 'easy cheap-model', state);
  assert.match(easy.output, /Easy model: cheap-model; strong model: strong-model/);
  const enabled = await runBuiltinCommand('routing', 'on', state);
  assert.match(enabled.output, /Automatic routing is on/);
  assert.equal(session.settings.modelRouting.enabled, true);

  const persisted = await loadSettings(root, { env });
  assert.deepEqual(persisted.modelRouting, {
    enabled: true,
    easyModel: 'cheap-model',
    strongModel: ''
  });

  const usage = createUsageTracker();
  recordUsage(usage, { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUsd: 0.002, costKnown: true });
  usage.routingTasks = 1;
  usage.routingSavingsUSD = 0.001;
  const response = await runBuiltinCommand('usage', '', { ...state, usage });
  assert.match(response.output, /Estimated cost: \$0\.0020/);
  assert.match(response.output, /estimated net savings versus the strong model: \$0\.0010/);

  await runBuiltinCommand('routing', 'off', state);
  assert.equal(session.settings.modelRouting.enabled, false);
  await runBuiltinCommand('routing', 'reset', state);
  assert.equal(session.settings.modelRouting.easyModel, '');
});

test('easy read-only requests use the cheaper model and restore the session default afterward', async (t) => {
  const root = await temporaryDirectory(t);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
  const { config, requests } = await scriptedModel(t, [
    { content: 'The README explains the project.' },
    { content: 'The authentication change needs a regression test.' }
  ]);
  config.model = 'strong-fixture';
  const session = await createSession({ root, config, bare: true, env });
  session.settings.modelRouting = {
    enabled: true,
    easyModel: 'cheap-fixture',
    strongModel: 'strong-fixture'
  };
  t.after(() => closeSession(session));

  const easyResult = await runAgentTurn(session, 'Summarize the README in three bullets.', { env });
  assert.equal(requests[0].model, 'cheap-fixture');
  assert.equal(easyResult.modelRouting.tier, 'easy');
  assert.equal(easyResult.modelRouting.selectedModel, 'cheap-fixture');
  assert.equal(easyResult.taskUsage.selectedModel, 'cheap-fixture');
  assert.equal(session.config.model, 'strong-fixture');

  const hardResult = await runAgentTurn(session, 'Fix the authentication bug and add regression tests.', { env });
  assert.equal(requests[1].model, 'strong-fixture');
  assert.equal(hardResult.modelRouting.tier, 'strong');
  assert.equal(hardResult.modelRouting.selectedModel, 'strong-fixture');
  assert.equal(session.config.model, 'strong-fixture');
});
