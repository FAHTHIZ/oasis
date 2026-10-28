import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession, thinkingBudgetFor, reasoningEffortFor } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

test('thinking keywords map to Claude Code budgets', () => {
  assert.equal(thinkingBudgetFor('fix the typo', {}, {}), 0);
  assert.equal(thinkingBudgetFor('I think this is broken', {}, {}), 0);
  assert.equal(thinkingBudgetFor('think about the edge cases', {}, {}), 4000);
  assert.equal(thinkingBudgetFor('think hard about this race', {}, {}), 10000);
  assert.equal(thinkingBudgetFor('ultrathink: redesign the cache', {}, {}), 31999);
  assert.equal(thinkingBudgetFor('fix it', { thinkingBudget: 2048 }, {}), 2048);
  assert.equal(thinkingBudgetFor('fix it', {}, { MAX_THINKING_TOKENS: '5000' }), 5000);
  assert.equal(thinkingBudgetFor('ultrathink', {}, { OASIS_THINKING: 'off' }), 0);
});

test('Anthropic extended thinking: budget sent, thinking blocks replayed with signatures in the tool loop', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-think-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-think-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  await writeFile(path.join(root, 'README.md'), 'hello');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const payload = JSON.parse(body);
    requests.push(payload);
    res.setHeader('content-type', 'application/json');
    const usage = { input_tokens: 10, output_tokens: 5 };
    if (requests.length === 1) {
      res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', content: [
        { type: 'thinking', thinking: 'I should read the README.', signature: 'sig-abc' },
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'README.md' } }
      ], stop_reason: 'tool_use', usage }));
    } else {
      res.end(JSON.stringify({ id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'It says hello.' }], stop_reason: 'end_turn', usage }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const config = { protocol: 'anthropic', baseURL: 'http://127.0.0.1:' + server.address().port, model: 'claude-test', apiKey: 'k', maxSteps: 5 };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const budgets = [];
  const result = await runAgentTurn(session, 'think hard: what does the README say?', { autoApprove: true, env, approval: async () => true, onThinkingBudget: (b) => budgets.push(b) });
  assert.equal(result.text, 'It says hello.');
  assert.deepEqual(budgets, [10000]);
  assert.deepEqual(requests[0].thinking, { type: 'enabled', budget_tokens: 10000 });
  assert.equal(requests[0].max_tokens, 18192);
  const replayed = requests[1].messages.find((message) => message.role === 'assistant');
  assert.deepEqual(replayed.content[0], { type: 'thinking', thinking: 'I should read the README.', signature: 'sig-abc' });
  assert.equal(replayed.content[1].type, 'tool_use');

  await runAgentTurn(session, 'thanks, now summarize', { autoApprove: true, env, approval: async () => true });
  assert.equal(requests[2].thinking, undefined);
  assert.equal(requests[2].max_tokens, 8192);
  assert.ok(requests[2].messages.every((message) => !Array.isArray(message.content) || message.content.every((block) => block.type !== 'thinking')));
});

test('think keywords map to OpenAI reasoning effort for reasoning models only', () => {
  assert.equal(reasoningEffortFor('ultrathink', { model: 'gpt-4o' }, {}), '');
  assert.equal(reasoningEffortFor('fix it', { model: 'o3' }, {}), '');
  assert.equal(reasoningEffortFor('think about it', { model: 'o4-mini' }, {}), 'low');
  assert.equal(reasoningEffortFor('think hard', { model: 'gpt-5' }, {}), 'medium');
  assert.equal(reasoningEffortFor('ultrathink', { model: 'openai/gpt-5-mini' }, {}), 'high');
  assert.equal(reasoningEffortFor('fix it', { model: 'custom', reasoningEffort: 'medium' }, {}), 'medium');
  assert.equal(reasoningEffortFor('think about it', { model: 'o3', reasoningEffort: 'high' }, {}), 'high');
  assert.equal(reasoningEffortFor('ultrathink', { model: 'o3' }, { OASIS_THINKING: 'off' }), '');
});

test('chat completions requests carry reasoning_effort only when it applies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-effort-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-effort-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const { config, requests } = await scriptedModel(t, [{ content: 'ok' }]);
  config.model = 'o3';
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const efforts = [];
  await runAgentTurn(session, 'ultrathink about the design', { autoApprove: true, env, approval: async () => true, onReasoningEffort: (e) => efforts.push(e) });
  assert.equal(requests[0].reasoning_effort, 'high');
  assert.deepEqual(efforts, ['high']);
  await runAgentTurn(session, 'thanks', { autoApprove: true, env, approval: async () => true });
  assert.equal(requests[1].reasoning_effort, undefined);
});
