import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { thinkingBudgetFor, requestCompletion } from '../src/agent.mjs';
import { thinkingTurnedOff } from '../src/model-budgets.mjs';
import { loadSettings } from '../src/settings.mjs';

test('alwaysThinkingEnabled: false turns thinking off unless MAX_THINKING_TOKENS is positive', () => {
  assert.equal(thinkingBudgetFor('ultrathink about this', { alwaysThinkingEnabled: false }, {}), 0);
  assert.equal(thinkingBudgetFor('', { alwaysThinkingEnabled: false, thinkingBudget: 12000 }, {}), 0);
  assert.equal(thinkingBudgetFor('', { alwaysThinkingEnabled: false }, { MAX_THINKING_TOKENS: '8000' }), 8000);
  assert.equal(thinkingTurnedOff({ alwaysThinkingEnabled: false }, {}), true);
  assert.equal(thinkingTurnedOff({ alwaysThinkingEnabled: false }, { MAX_THINKING_TOKENS: '8000' }), false);
  assert.equal(thinkingBudgetFor('ultrathink', { alwaysThinkingEnabled: true }, {}), 31999);
  // MAX_THINKING_TOKENS=0 turns thinking off, as in Claude Code.
  assert.equal(thinkingBudgetFor('ultrathink', {}, { MAX_THINKING_TOKENS: '0' }), 0);
  assert.equal(thinkingTurnedOff({}, { MAX_THINKING_TOKENS: '0' }), true);
  assert.equal(thinkingTurnedOff({}, {}), false);
});

async function body(model, extra) {
  const originalFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await requestCompletion({ config: { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model, apiKey: 'k' }, toolDefinitions: [], messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], ...extra });
  } finally { globalThis.fetch = originalFetch; }
  return sent;
}

test('with thinking off, a 4.6 model gets no thinking field and effort capped at high; always-thinking models are unchanged', async () => {
  const off = await body('claude-opus-4-6', { thinkingOff: true, thinkingBudget: 0, effortLevel: 'max' });
  assert.equal(off.thinking, undefined);
  assert.deepEqual(off.output_config, { effort: 'high' });
  const on = await body('claude-opus-4-6', { thinkingBudget: 0, effortLevel: 'max' });
  assert.deepEqual(on.thinking, { type: 'adaptive', display: 'summarized' });
  const always = await body('claude-opus-5-5', { thinkingOff: true, thinkingBudget: 0, effortLevel: 'high' });
  assert.deepEqual(always.thinking, { type: 'adaptive', display: 'summarized' });
});

test('alwaysThinkingEnabled is read from any settings file, an untrusted repository too', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-thinking-'));
  const home = path.join(root, 'home');
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ alwaysThinkingEnabled: false }));
  const env = { OASIS_CONFIG_DIR: home, HOME: home, CLAUDE_CONFIG_DIR: home, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: '' };
  assert.equal((await loadSettings(root, { env })).alwaysThinkingEnabled, false);
  assert.equal((await loadSettings(root, { env: { ...env, OASIS_TRUST_WORKSPACE: '1' } })).alwaysThinkingEnabled, false);
});
