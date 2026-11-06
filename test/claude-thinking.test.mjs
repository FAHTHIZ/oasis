import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeThinkingMode, claudeEffortFor, applyEffort, requestCompletion } from '../src/agent.mjs';

test('claudeThinkingMode follows the model generation', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-haiku-5-5', 'claude-fable-5-1', 'us.anthropic.claude-opus-5-5', 'claude-opus-5-5@2026-10-01']) assert.equal(claudeThinkingMode(id), 'adaptive-only', id);
  for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'anthropic.claude-opus-4-6-v1']) assert.equal(claudeThinkingMode(id), 'adaptive', id);
  for (const id of ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-opus-4-1-20250805', 'claude-haiku-4-5', 'claude-3-7-sonnet-latest', 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'deepseek-chat', 'kimi-k2', '']) assert.equal(claudeThinkingMode(id), 'budget', id);
});

test('claudeEffortFor maps /effort and think keywords, never lowering below the default', () => {
  assert.equal(claudeEffortFor('claude-opus-5-5', { budget: 31999 }), 'xhigh');
  assert.equal(claudeEffortFor('claude-opus-4-6', { budget: 31999 }), 'high', '4.6 has no xhigh');
  assert.equal(claudeEffortFor('claude-opus-5-5', { budget: 4000 }), '', 'a plain think keeps the model default');
  assert.equal(claudeEffortFor('claude-opus-5-5', { level: 'max', budget: 63999 }), 'max');
  assert.equal(claudeEffortFor('claude-opus-5-5', { level: 'low', budget: 4000 }), 'low');
  assert.equal(claudeEffortFor('claude-opus-5-5', { level: 'low', budget: 31999 }), 'xhigh', 'ultrathink raises one turn');
  assert.equal(claudeEffortFor('claude-sonnet-4-5', { level: 'high', budget: 32000 }), '');
  assert.equal(applyEffort({}, 'max').effortLevel, 'max');
  assert.equal(applyEffort({ effortLevel: 'max' }, null).effortLevel, undefined);
});

async function captureAnthropicBody(model, sessionExtra = {}, options = {}) {
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: options.forceTool ? [{ type: 'tool_use', id: 't', name: options.forceTool, input: { ready: true } }] : [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const session = { config: { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model, apiKey: 'k' }, toolDefinitions: [{ type: 'function', function: { name: 'probe', description: 'p', parameters: { type: 'object', properties: {} } } }], messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], ...sessionExtra };
    await requestCompletion(session, options);
  } finally { globalThis.fetch = originalFetch; }
  return body;
}

test('Claude 4.7+ gets adaptive thinking with effort instead of a rejected budget_tokens', async () => {
  const body = await captureAnthropicBody('claude-opus-5-5', { thinkingBudget: 31999, effortLevel: '' });
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
  const legacy = await captureAnthropicBody('claude-sonnet-4-5', { thinkingBudget: 10000 });
  assert.deepEqual(legacy.thinking, { type: 'enabled', budget_tokens: 10000 });
  assert.equal(legacy.output_config, undefined);
  const plain = await captureAnthropicBody('claude-opus-5-5', {});
  assert.equal(plain.thinking, undefined, 'no thinking field keeps the model default');
  assert.equal(plain.output_config, undefined);
});

test('forced tool_choice is not sent to Claude 4.7+ models, which reject it', async () => {
  const modern = await captureAnthropicBody('claude-opus-5-5', {}, { forceTool: 'probe' });
  assert.deepEqual(modern.tool_choice, { type: 'auto' });
  const older = await captureAnthropicBody('claude-sonnet-4-5', {}, { forceTool: 'probe' });
  assert.deepEqual(older.tool_choice, { type: 'tool', name: 'probe' });
});

test('adaptive models replay signed thinking blocks in a tool loop even without a budget', async () => {
  const block = { type: 'thinking', thinking: 'plan', signature: 'sig' };
  const body = await captureAnthropicBody('claude-opus-5-5', { messages: [
    { role: 'system', content: 's' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', thinkingBlocks: [block], tool_calls: [{ id: 't1', type: 'function', function: { name: 'probe', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'probe', content: '{}' }
  ] });
  const assistant = body.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(assistant.content[0], block);
});
