import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractCorrections, correctionViolations } from '../src/standing-corrections.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

test('extracts phrase bans and ignores coding rules', () => {
  assert.deepEqual(extractCorrections('stop saying load-bearing and fix the bug'), ['load-bearing']);
  assert.deepEqual(extractCorrections('Please stop using the word "leverage".'), ['leverage']);
  assert.deepEqual(extractCorrections('never say “You\'re absolutely right”'), ["You're absolutely right"]);
  assert.deepEqual(extractCorrections("don't say 'great question'"), ['great question']);
  for (const text of ['stop saying that', "don't use the database", 'never use `any` types', 'never use "var" in JS', 'stop using "lodash"', 'fix the load-bearing wall']) {
    assert.deepEqual(extractCorrections(text), [], text);
  }
});

test('violations ignore code and respect word boundaries', () => {
  assert.deepEqual(correctionViolations(['load-bearing'], 'This check is load-bearing.'), ['load-bearing']);
  assert.deepEqual(correctionViolations(['load-bearing'], 'See `load-bearing` and\n```\nload-bearing\n```'), []);
  assert.deepEqual(correctionViolations(["You're absolutely right"], 'You’re absolutely right!'), ["You're absolutely right"]);
  assert.deepEqual(correctionViolations(['robust'], 'robustness matters'), []);
});

test('a phrase ban is enforced, restated every turn, and inherited by the next session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-corr-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-corr-cfg-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(configDir, { recursive: true, force: true })]));
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir };
  const replies = ['That guard is load-bearing.', 'That guard is essential.', 'Fine, it is load-bearing.', 'It is critical.'];
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: replies[payloads.length - 1] || 'ok' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 };
  const first = await createSession({ root, config, env });
  const result = await runAgentTurn(first, 'Please stop saying "load-bearing". Is the guard needed?', { autoApprove: true, env });
  assert.equal(result.text, 'That guard is essential.');
  const nudge = payloads[1].messages.at(-1);
  assert.equal(nudge.role, 'user');
  assert.match(nudge.content, /"load-bearing", which the user explicitly asked you to stop using/);
  assert.match(payloads[0].messages.at(-1).content, /<standing-corrections>[\s\S]*"load-bearing"/);

  const second = await createSession({ root, config, env });
  assert.deepEqual(second.standingCorrections, ['load-bearing']);
  const later = await runAgentTurn(second, 'and the other guard?', { autoApprove: true, env });
  assert.equal(later.text, 'It is critical.');
  assert.match(payloads[2].messages.at(-1).content, /<standing-corrections>/);
});
