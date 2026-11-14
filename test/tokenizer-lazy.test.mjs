// A short headless run loaded the o200k vocabulary before its first request:
// about 160 ms and 55 MB of peak RSS to count a prompt far below any limit.
// Budget checks now use a byte upper bound first and tokenize only when it
// cannot settle the question.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { estimateTokens, tokenUpperBound, microcompact } from '../src/context.mjs';
import { historyBudgetSize, historyWithinBudget } from '../src/compaction-history.mjs';

const samples = [
  [{ role: 'user', content: 'hello world, please fix the failing test in src/app.js' }],
  [{ role: 'user', content: '我们正在编写一个代码代理程序。'.repeat(200) }],
  [{ role: 'user', content: 'আমি বাংলায় কথা বলি 😀🚀 '.repeat(300) }],
  [{ role: 'tool', name: 'read_file', content: JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, ok: i % 2 === 0 }))) }],
  [{ role: 'tool', name: 'run', content: Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7919) % 256)).toString('base64') }],
  [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a.js', old: 'x'.repeat(500), new: 'y' }) } }] }],
  [{ role: 'user', content: 'see image', images: [{ width: 1024, height: 768 }] }],
  [{ role: 'assistant', content: 'r', responseItems: [{ type: 'reasoning', summary: [{ text: 'think '.repeat(400) }] }] }],
  [{ role: 'user', content: [{ type: 'text', text: 'structured '.repeat(100) }] }]
];

test('the byte bound is never below the real token count', () => {
  for (const messages of samples) assert.ok(tokenUpperBound(messages) >= estimateTokens(messages), JSON.stringify(messages).slice(0, 60));
  assert.ok(tokenUpperBound(samples.flat()) >= estimateTokens(samples.flat()));
});

test('historyWithinBudget gives the same answer as the exact size at every limit', () => {
  for (const messages of [...samples, samples.flat()]) {
    const exact = historyBudgetSize(messages);
    for (const limit of [0, 100, exact - 1, exact, exact + 1, exact * 2, tokenUpperBound(messages) * 4, 10_000_000]) {
      assert.equal(historyWithinBudget(messages, limit), exact <= limit, 'limit ' + limit);
    }
  }
});

test('microcompact under its trigger returns the input and still reports the count on demand', () => {
  const messages = samples.flat();
  const result = microcompact(messages, { windowTokens: 1_000_000 });
  assert.equal(result.pruned, 0);
  assert.equal(result.messages, messages);
  assert.equal(result.before, estimateTokens(messages));
  assert.equal(result.after, result.before);
});

test('a short headless turn does not load the tokenizer', () => {
  const agentUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'agent.mjs')).href;
  const script = `
    import http from 'node:http';
    import { createRequire } from 'node:module';
    import os from 'node:os';
    const server = http.createServer((req, res) => { req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { createSession, runAgentTurn } = await import(${JSON.stringify(agentUrl)});
    const session = await createSession({ root: os.tmpdir(), config: { baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'x', model: 'm', protocol: 'openai-compatible' } });
    await runAgentTurn(session, 'say ok', { autoApprove: true });
    server.close();
    const loaded = Object.keys(createRequire(import.meta.url).cache).some((key) => key.includes('gpt-tokenizer'));
    console.log(JSON.stringify({ loaded, reply: session.messages.at(-1).content }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, OASIS_DEBUG: '' } });
  const result = JSON.parse(out.trim().split('\n').pop());
  assert.equal(result.reply, 'ok');
  assert.equal(result.loaded, false);
});
