import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { detectRepetition, collapseRepetition } from '../src/degenerate-output.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

test('a reply that keeps repeating one sentence is detected, with where the loop starts', () => {
  const head = 'I will add the function now.\n';
  const unit = 'Let me check the file again. ';
  const text = head + unit.repeat(120);
  const found = detectRepetition(text);
  assert.ok(found);
  assert.equal(found.unit.trim(), unit.trim());
  assert.ok(found.repeats >= 100);
  assert.ok(collapseRepetition(text, found).startsWith(head));
  assert.match(collapseRepetition(text, found), /repeated \d+ more times; cut off/);
});

test('single characters and blank lines running on are caught too', () => {
  assert.ok(detectRepetition('ok ' + '\n'.repeat(3000)));
  assert.ok(detectRepetition('x'.repeat(2500)));
});

test('ordinary long output with structure is not mistaken for a loop', () => {
  const table = '| a | b |\n|---|---|\n' + Array.from({ length: 200 }, (_, i) => '| ' + i + ' | ' + (i * i) + ' |\n').join('');
  assert.equal(detectRepetition(table), null);
  const code = Array.from({ length: 150 }, (_, i) => 'export const value' + i + ' = ' + i + ';\n').join('');
  assert.equal(detectRepetition(code), null);
  // A short repeat below the length floor (a ruled line, a few zeros).
  assert.equal(detectRepetition('Results\n' + '='.repeat(80) + '\n' + '0, '.repeat(100)), null);
  assert.equal(detectRepetition('short'), null);
});

async function streamingProvider(t, replies) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const payload = JSON.parse(body);
    requests.push(payload);
    const reply = replies[Math.min(requests.length, replies.length) - 1];
    res.setHeader('content-type', 'text/event-stream');
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    if (reply.loop) {
      // An endless loop: keep sending until the client hangs up.
      let open = true;
      res.on('close', () => { open = false; });
      req.on('close', () => { open = false; });
      for (let i = 0; i < 5000 && open; i++) {
        send({ choices: [{ index: 0, delta: { content: reply.loop }, finish_reason: null }] });
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (open) { send({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }); res.end('data: [DONE]\n\n'); }
      return;
    }
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, baseURL: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-degen-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-degen-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  return { root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') } };
}

test('a streamed reply stuck in a loop is cut, the model is told why, and the next reply is used', async (t) => {
  const { root, env } = await workspace(t);
  const provider = await streamingProvider(t, [{ loop: 'Let me check the file again. ' }, { text: 'The function is in a.mjs.' }]);
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'small-model', apiKey: 'k', maxSteps: 5 }, env });
  t.after(() => closeSession(session));
  const restarts = [];
  const started = Date.now();
  const result = await runAgentTurn(session, 'Where is add?', { autoApprove: true, env, onDelta: () => {}, onStreamRestart: (event) => restarts.push(event.kind) });
  assert.ok(Date.now() - started < 20000);
  assert.equal(result.text, 'The function is in a.mjs.');
  assert.deepEqual(restarts, ['degenerate-output']);
  const resent = provider.requests[1].messages;
  assert.match(resent.at(-1).content, /got stuck repeating the same text/);
  assert.match(resent.at(-2).content, /repeated \d+ more times; cut off/);
  assert.ok(resent.at(-2).content.length < 4200, 'only one copy of the loop goes back to the model');
});

test('three looping replies in a row end the turn with a clear error', async (t) => {
  const { root, env } = await workspace(t);
  const provider = await streamingProvider(t, [{ loop: 'again and again ' }]);
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'small-model', apiKey: 'k', maxSteps: 8 }, env });
  t.after(() => closeSession(session));
  await assert.rejects(runAgentTurn(session, 'hi', { autoApprove: true, env, onDelta: () => {} }), /kept repeating the same text/);
  assert.equal(provider.requests.length, 3);
});
