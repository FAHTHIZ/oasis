import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, steerSession, takeSteering, pendingSteering, steeringMessage, STEER_LIMIT } from '../src/agent.mjs';

// A scripted model whose step callback can act (e.g. steer) while a request is in flight.
async function scriptedModel(t, steps, onRequest) {
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    if (onRequest) onRequest(payloads.length - 1);
    const step = steps[Math.min(payloads.length - 1, steps.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: step }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, payloads };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-steer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'hello\n');
  return root;
}
const config = (port) => ({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 });
const read = (id) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }] });
const userTexts = (payload) => payload.messages.filter((m) => m.role === 'user').map((m) => String(m.content));

test('steering queue helpers trim, cap, and drain in order', () => {
  const session = {};
  assert.equal(steerSession(session, '   '), false);
  assert.equal(steerSession(null, 'x'), false);
  assert.equal(steerSession(session, ' first '), true);
  assert.equal(steerSession(session, 'second'), true);
  assert.equal(pendingSteering(session), 2);
  assert.deepEqual(takeSteering(session), ['first', 'second']);
  assert.equal(pendingSteering(session), 0);
  for (let i = 0; i < STEER_LIMIT; i++) steerSession(session, 'm' + i);
  assert.equal(steerSession(session, 'overflow'), false, 'queue is bounded');
  assert.match(steeringMessage(['use pnpm']), /while you were working:\n\nuse pnpm/);
  assert.match(steeringMessage(['a', 'b']), /1\. a\n2\. b/);
  assert.equal(steeringMessage([]), '');
});

test('a message sent mid-turn reaches the model at its next step as a user message', async (t) => {
  const root = await fixture(t);
  let session;
  const model = await scriptedModel(t, [read('r1'), { role: 'assistant', content: 'Switched to pnpm as asked.' }], (index) => {
    if (index === 0) steerSession(session, 'Use pnpm, not npm.');
  });
  session = await createSession({ root, config: config(model.port) });
  const seen = [];
  const result = await runAgentTurn(session, 'Read a.txt.', { onSteer: (info) => seen.push(info.delivered) });
  assert.equal(result.finished, true);
  assert.equal(model.payloads.length, 2);
  const second = model.payloads[1];
  const last = second.messages[second.messages.length - 1];
  assert.equal(last.role, 'user', 'steering is a real user message, not tool output');
  assert.match(last.content, /Use pnpm, not npm\./);
  assert.ok(second.messages.some((m) => m.role === 'tool'), 'the tool result is still sent');
  assert.deepEqual(seen, [1]);
  assert.equal(pendingSteering(session), 0);
});

test('a message that arrives while the model writes its final answer keeps the turn going', async (t) => {
  const root = await fixture(t);
  let session;
  const model = await scriptedModel(t, [{ role: 'assistant', content: 'All done.' }, { role: 'assistant', content: 'Added the README note too.' }], (index) => {
    if (index === 0) steerSession(session, 'Also add a README note.');
  });
  session = await createSession({ root, config: config(model.port) });
  const shown = [];
  const result = await runAgentTurn(session, 'Say done.', { onText: (text) => shown.push(text) });
  assert.equal(model.payloads.length, 2, 'the turn continued instead of ending');
  assert.ok(userTexts(model.payloads[1]).some((text) => text.includes('Also add a README note.')));
  assert.equal(result.text, 'Added the README note too.');
  assert.ok(shown.includes('All done.'), 'the interim answer is still shown');
});

test('subagent turns never consume the parent conversation steering', async (t) => {
  const root = await fixture(t);
  const model = await scriptedModel(t, [read('r1'), { role: 'assistant', content: 'ok' }]);
  const session = await createSession({ root, config: config(model.port) });
  steerSession(session, 'for the parent');
  await runAgentTurn(session, 'Read a.txt.', { isSubagent: true });
  assert.equal(pendingSteering(session), 1, 'left for the interface to send next');
  assert.deepEqual(takeSteering(session), ['for the parent']);
});

test('stream-json: a user line with steer:true goes to the running turn, others queue', async () => {
  const { createStreamJsonChannel } = await import('../src/headless.mjs');
  const { PassThrough } = await import('node:stream');
  const readline = await import('node:readline');
  const input = new PassThrough();
  const lines = readline.createInterface({ input });
  const written = [];
  const channel = createStreamJsonChannel(lines, (event) => written.push(event));
  const steered = [];
  let busy = true;
  channel.onSteer((text) => busy && (steered.push(text), true));
  const iterator = channel[Symbol.asyncIterator]();
  input.write(JSON.stringify({ type: 'user', steer: true, message: { role: 'user', content: 'use pnpm' } }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(steered, ['use pnpm']);
  assert.equal(written.at(-1).subtype, 'steer_queued');
  busy = false;
  input.write(JSON.stringify({ type: 'user', steer: true, message: { role: 'user', content: 'later' } }) + '\n');
  assert.deepEqual(await iterator.next(), { value: 'later', done: false }, 'not running: becomes the next turn');
  channel.unshift('first');
  assert.deepEqual(await iterator.next(), { value: 'first', done: false });
  input.end();
});
