import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSettings } from '../src/settings.mjs';

// Regression: these documented keys are read by createSession but used to be dropped by loadSettings.
test('session behavior keys survive loadSettings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-keys-'));
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-keys-cfg-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true })]));
  const values = { fastMode: true, ultracode: true, mcpNonBlocking: true, workflowsEnabled: false, leanTools: false, subagentEffort: 'low', systemPromptSnapshot: 'on', teammateMode: 'tmux', toolSearchThreshold: 7 };
  await writeFile(path.join(config, 'settings.json'), JSON.stringify(values));
  const env = { ...process.env, OASIS_CONFIG_DIR: config, OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  const settings = await loadSettings(root, { env, skipPlugins: true });
  for (const [key, value] of Object.entries(values)) assert.deepEqual(settings[key], value, key);
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ fastMode: 'yes', subagentEffort: 'extreme', teammateMode: 'screen', toolSearchThreshold: -1, systemPromptSnapshot: 1 }));
  const invalid = await loadSettings(root, { env, skipPlugins: true });
  for (const key of ['fastMode', 'subagentEffort', 'teammateMode', 'toolSearchThreshold', 'systemPromptSnapshot']) assert.equal(invalid[key], undefined, key);
});

test('subagents can use their own auto-compact threshold', async (t) => {
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-subcompact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [
    (payload) => payload.messages[0].content.includes('SUBAGENT MODE') ? { content: 'child done' } : payload.messages.some((m) => m.role === 'tool') ? { content: 'parent done' } : toolCall('t1', 'task', { description: 'look', prompt: 'look around', subagent_type: 'general-purpose' })
  ]);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_SUBAGENT_AUTOCOMPACT_PCT: '35' };
  const session = await createSession({ root, config, env, settings: { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'delegate', { env, autoApprove: true });
  const record = [...session.agentTasks.agents.values()][0];
  assert.ok(record, 'a subagent ran');
  assert.equal(record.child.config.autoCompactPercent, 35);
  assert.equal(session.config.autoCompactPercent, undefined);
});
