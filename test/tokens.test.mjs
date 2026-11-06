import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { countTextTokens, countJsonTokens } from '../src/tokens.mjs';
import { estimateTokens, contextTokens, recordContextAnchor } from '../src/context.mjs';
import { createSession, runAgentTurn, historyBudgetSizeForTest } from '../src/agent.mjs';

test('token counts use a real BPE vocabulary, not characters / 4', () => {
  assert.equal(countTextTokens(''), 0);
  assert.equal(countTextTokens('hello world'), 2);
  // Dense scripts and JSON carry far more tokens per character than English.
  const chinese = '我们正在编写一个代码代理程序，用于自动化软件开发。'.repeat(100);
  assert.ok(countTextTokens(chinese) > chinese.length * 0.5, 'Chinese is about one token per 1.7 characters, not 4');
  const bangla = 'আমি বাংলায় কথা বলি এবং কোড লিখি। '.repeat(100);
  assert.ok(countTextTokens(bangla) > bangla.length / 4 * 1.2);
  const json = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, ok: i % 2 === 0, v: [i, i + 1] })));
  assert.ok(countJsonTokens(JSON.parse(json)) > json.length / 4 * 1.3);
  // Special-token text in a file is ordinary text and must not throw.
  assert.ok(countTextTokens('before <|endoftext|> after <|im_start|>') > 5);
});

test('long unbroken input is counted quickly and consistently', () => {
  const run = 'a'.repeat(1_000_000);
  const started = Date.now();
  const tokens = countTextTokens(run);
  assert.ok(Date.now() - started < 1000, 'a 1 MB run without spaces stays linear');
  assert.ok(Math.abs(tokens - 125_000) < 200);
});

test('estimateTokens caches per message and notices replaced content', () => {
  const message = { role: 'tool', content: 'x '.repeat(5000) };
  const first = estimateTokens([message]);
  assert.equal(estimateTokens([message]), first);
  message.content = '我们正在编写'.repeat(500);
  assert.notEqual(estimateTokens([message]), first, 'a changed content string is recounted');
  const withCalls = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"src/agent.mjs"}' } }] };
  assert.ok(estimateTokens([withCalls]) >= 8);
  assert.equal(estimateTokens([{ role: 'user', content: '', images: [{}, {}] }]), 3200);
});

test('context uses the provider-reported count for the prefix it saw, and falls back after compaction', () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
  const session = { messages };
  recordContextAnchor(session, { inputTokens: 5000, estimated: true }, 2, messages[1]);
  assert.equal(session.contextAnchor, undefined, 'estimated usage is never treated as reported');
  recordContextAnchor(session, { inputTokens: 5000 }, 2, messages[1]);
  messages.push({ role: 'assistant', content: 'hello there' });
  const anchored = contextTokens(session);
  assert.equal(anchored.reported, true);
  assert.equal(anchored.tokens, 5000 + countTextTokens('hello there'));
  session.messages = [messages[0], { role: 'user', content: 'Summary of earlier work' }];
  assert.deepEqual(contextTokens(session), { tokens: estimateTokens(session.messages), reported: false });
});

test('an agent turn anchors context to the provider usage of its last request', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-tokens-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 4321, completion_tokens: 2, total_tokens: 4323 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 2 }, settings: { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } } });
  await runAgentTurn(session, 'say done', {});
  const context = contextTokens(session);
  assert.equal(context.reported, true);
  assert.ok(context.tokens >= 4321 && context.tokens < 4400, 'provider count plus the short reply: ' + context.tokens);
});

test('compaction budgeting counts dense content by tokens, not only characters', () => {
  const english = [{ role: 'user', content: 'The quick brown fox jumps over the lazy dog. '.repeat(400) }];
  const chinese = [{ role: 'user', content: '我们正在编写一个代码代理程序，用于自动化软件开发。'.repeat(400) }];
  const chars = (messages) => messages[0].content.length;
  assert.equal(historyBudgetSizeForTest(english), chars(english), 'English is sized by characters as before');
  assert.ok(historyBudgetSizeForTest(chinese) > chars(chinese) * 2, 'Chinese is sized by its real token count');
});
