import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { resolveModelAlias } from '../src/model-aliases.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

test('model aliases resolve like Claude Code', () => {
  assert.equal(resolveModelAlias('opus', { protocol: 'anthropic', env: {} }), 'claude-opus-5-5');
  assert.equal(resolveModelAlias('sonnet[1m]', { protocol: 'anthropic', env: {} }), 'claude-sonnet-5-5');
  assert.equal(resolveModelAlias('best', { protocol: 'anthropic', env: {} }), 'claude-fable-5-1');
  assert.equal(resolveModelAlias('opusplan', { protocol: 'anthropic', env: {}, planMode: true }), 'claude-opus-5-5');
  assert.equal(resolveModelAlias('opusplan', { protocol: 'anthropic', env: {}, planMode: false }), 'claude-sonnet-5-5');
  assert.equal(resolveModelAlias('opus', { protocol: 'anthropic', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'pinned' } }), 'pinned');
  assert.equal(resolveModelAlias('opus', { protocol: 'openai-compatible', env: {} }), 'opus');
  assert.equal(resolveModelAlias('gpt-5', { protocol: 'anthropic', env: {} }), 'gpt-5');
});

test('aliases are resolved in outgoing requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-alias-'));
  const { config, requests } = await scriptedModel(t, [{ content: 'hi' }]);
  const session = await createSession({ root, config: { ...config, model: 'haiku' }, settings, env: { ...process.env, HOME: root, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'tiny-model' } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'hello');
  assert.equal(requests[0].model, 'tiny-model');
});

test('advisor tool consults a second model with the transcript', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-advisor-'));
  const { config, requests } = await scriptedModel(t, [(payload) => {
    if (payload.model === 'big-brain') return { content: 'ADVICE: check the null case' };
    const last = payload.messages[payload.messages.length - 1];
    if (last.role === 'user') return toolCall('a1', 'advisor', { question: 'what next?' });
    return { content: 'done: ' + last.content };
  }]);
  const session = await createSession({ root, config, settings, env: { ...process.env, HOME: root }, advisor: 'big-brain' });
  t.after(() => closeSession(session));
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'advisor'));
  const reply = await runAgentTurn(session, 'fix bug XYZ-UNIQUE');
  const advisorRequest = requests.find((r) => r.model === 'big-brain');
  assert.match(JSON.stringify(advisorRequest.messages), /XYZ-UNIQUE/);
  assert.ok(!advisorRequest.tools || !advisorRequest.tools.length);
  assert.match(JSON.stringify(reply), /check the null case/);
  const status = await runBuiltinCommand('advisor', '', { root, session, env: process.env });
  assert.match(status.output, /big-brain \(1 consultation/);
  await runBuiltinCommand('advisor', 'off', { root, session, env: process.env });
  assert.ok(!session.toolDefinitions.some((tool) => tool.function.name === 'advisor'));
});
