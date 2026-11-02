import test from 'node:test';
import assert from 'node:assert/strict';
import { parallelToolCalls } from '../src/agent.mjs';

test('parallel tool calls are on by default with env and config opt-outs', () => {
  assert.equal(parallelToolCalls({}, {}), true);
  assert.equal(parallelToolCalls({ parallelToolCalls: false }, {}), false);
  assert.equal(parallelToolCalls({}, { OASIS_PARALLEL_TOOL_CALLS: '0' }), false);
  assert.equal(parallelToolCalls({}, { OASIS_PARALLEL_TOOL_CALLS: 'off' }), false);
  assert.equal(parallelToolCalls({ parallelToolCalls: false }, { OASIS_PARALLEL_TOOL_CALLS: '1' }), true);
});

test('the chat request advertises parallel tool calls and a batch of reads runs', async (t) => {
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const { createSession, runAgentTurn } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-par-'));
  await writeFile(path.join(root, 'a.txt'), 'alpha');
  await writeFile(path.join(root, 'b.txt'), 'beta');
  const call = (id, file) => ({ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } });
  const { config, requests } = await scriptedModel(t, [
    { content: null, tool_calls: [call('c1', 'a.txt'), call('c2', 'b.txt')] },
    (payload) => ({ content: JSON.stringify(payload.messages).includes('alpha') && JSON.stringify(payload.messages).includes('beta') ? 'BOTH' : 'MISSING' })
  ]);
  const session = await createSession({ root, config, permissionMode: 'default', env: { ...process.env, OASIS_PARALLEL_TOOL_CALLS: '' } });
  const result = await runAgentTurn(session, 'read both', { env: { ...process.env, OASIS_PARALLEL_TOOL_CALLS: '' } });
  assert.equal(requests[0].parallel_tool_calls, true);
  assert.match(String(result.text || result.finalText || JSON.stringify(result)), /BOTH/);
});

test('prompt cache key is stable per session and agent, and only sent to OpenAI by default', async () => {
  const { promptCacheKeyField } = await import('../src/agent.mjs');
  const openai = { baseURL: 'https://api.openai.com/v1' };
  const main = { sessionId: '11111111-2222-4333-8444-555555555555' };
  const a = promptCacheKeyField(main, openai, {});
  assert.match(a.prompt_cache_key, /^oasis-[0-9a-f]{32}$/);
  assert.deepEqual(promptCacheKeyField(main, openai, {}), a);
  assert.notDeepEqual(promptCacheKeyField({ ...main, agentId: 'agent_1' }, openai, {}), a);
  assert.ok(!a.prompt_cache_key.includes('1111'), 'the session id is hashed, not sent');
  assert.deepEqual(promptCacheKeyField(main, { baseURL: 'https://gateway.example/v1' }, {}), {});
  assert.ok(promptCacheKeyField(main, { baseURL: 'https://gateway.example/v1' }, { OASIS_PROMPT_CACHE_KEY: '1' }).prompt_cache_key);
  assert.deepEqual(promptCacheKeyField(main, openai, { OASIS_PROMPT_CACHE_KEY: '0' }), {});
  const unsaved = {};
  assert.deepEqual(promptCacheKeyField(unsaved, openai, {}), promptCacheKeyField(unsaved, openai, {}));
});
