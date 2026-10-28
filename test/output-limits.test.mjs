import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession, maxOutputTokensFor, outputCapFromError } from '../src/agent.mjs';

test('output-token defaults are model-aware and overridable like Claude Code', () => {
  assert.equal(maxOutputTokensFor({ model: 'claude-sonnet-4-5' }, {}), 32000);
  assert.equal(maxOutputTokensFor({ model: 'claude-3-7-sonnet-latest' }, {}), 32000);
  assert.equal(maxOutputTokensFor({ model: 'claude-3-5-sonnet-20241022' }, {}), 8192);
  assert.equal(maxOutputTokensFor({ model: 'gpt-4o' }, {}), 16384);
  assert.equal(maxOutputTokensFor({ model: 'my-local-model' }, {}), 8192);
  assert.equal(maxOutputTokensFor({ model: 'claude-opus-4' }, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' }), 64000);
  assert.equal(maxOutputTokensFor({ model: 'x', maxOutputTokens: 20000 }, {}), 20000);
  assert.equal(outputCapFromError(400, 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens'), 32000);
  assert.equal(outputCapFromError(400, 'unrelated validation error'), 0);
  assert.equal(outputCapFromError(500, 'max_tokens'), 0);
});

async function fakeProvider(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const payload = JSON.parse(body);
    requests.push(payload);
    const [status, reply] = handler(payload, requests.length);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, baseURL: 'http://127.0.0.1:' + server.address().port };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-out-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-out-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  return { root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_MAX_OUTPUT_TOKENS: '', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '' } };
}

test('a tool call cut off by max_tokens is not executed and the model is asked to resume in smaller steps', async (t) => {
  const { root, env } = await workspace(t);
  const usage = { input_tokens: 10, output_tokens: 5 };
  const provider = await fakeProvider(t, (_payload, n) => n === 1
    ? [200, { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Writing it now.' }, { type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: 'big.txt' } }], stop_reason: 'max_tokens', usage }]
    : [200, { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done in smaller parts.' }], stop_reason: 'end_turn', usage }]);
  const config = { protocol: 'anthropic', baseURL: provider.baseURL, model: 'claude-sonnet-4-5', apiKey: 'k', maxSteps: 5 };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const events = [];
  const result = await runAgentTurn(session, 'write a big file', { autoApprove: true, env, approval: async () => true, onOutputTruncated: (e) => events.push(e) });
  assert.equal(result.text, 'Done in smaller parts.');
  assert.equal(provider.requests[0].max_tokens, 32000);
  assert.deepEqual(events, [{ limit: 32000, droppedTool: 'write_file', attempt: 1 }]);
  await assert.rejects(access(path.join(root, 'big.txt')));
  const resumed = JSON.stringify(provider.requests[1].messages);
  assert.match(resumed, /hit the 32000-token output limit/);
  assert.match(resumed, /write_file` tool call was incomplete and was NOT executed/);
  assert.doesNotMatch(resumed, /tu1/, 'the dropped tool_use must not be replayed without a result');
});

test('chat-completions finish_reason=length continues instead of returning a truncated answer', async (t) => {
  const { root, env } = await workspace(t);
  const provider = await fakeProvider(t, (_payload, n) => [200, n === 1
    ? { choices: [{ message: { role: 'assistant', content: 'Part one' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 3 } }
    : { choices: [{ message: { role: 'assistant', content: 'Part two.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3 } }]);
  const config = { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'local-model', apiKey: 'k', maxSteps: 5 };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'explain', { autoApprove: true, env, approval: async () => true });
  assert.equal(result.text, 'Part two.');
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0].max_tokens, undefined, 'chat gateways only receive max_tokens when configured');
  assert.match(JSON.stringify(provider.requests[1].messages), /Resume directly/);
});

test('a provider 400 naming a smaller output cap lowers the limit and retries once', async (t) => {
  const { root, env } = await workspace(t);
  const provider = await fakeProvider(t, (payload) => payload.max_tokens > 16000
    ? [400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: ' + payload.max_tokens + ' > 16000, which is the maximum allowed number of output tokens' } }]
    : [200, { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }]);
  const config = { protocol: 'anthropic', baseURL: provider.baseURL, model: 'claude-sonnet-4-5', apiKey: 'k', maxSteps: 3 };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'hi', { autoApprove: true, env, approval: async () => true });
  assert.equal(result.text, 'ok');
  assert.deepEqual(provider.requests.map((r) => r.max_tokens), [32000, 16000]);
  await runAgentTurn(session, 'again', { autoApprove: true, env, approval: async () => true });
  assert.equal(provider.requests[2].max_tokens, 16000, 'the learned cap persists for the session');
});
