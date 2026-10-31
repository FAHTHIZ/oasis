import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';

async function scriptedModel(t, steps) {
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    const step = steps[Math.min(payloads.length - 1, steps.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: step }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, payloads };
}

const read = (id) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'big.txt' }) } }] });

function toolContents(payload) {
  return payload.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
}

test('re-reading an unchanged file returns a short pointer instead of the full content', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dedup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Array.from({ length: 200 }, (_, i) => 'line ' + i + ' of a fairly large file').join('\n');
  await writeFile(path.join(root, 'big.txt'), body);
  const model = await scriptedModel(t, [read('r1'), read('r2'), { role: 'assistant', content: 'done' }]);
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + model.port + '/v1', model: 'fixture', apiKey: '', maxSteps: 5 } });
  const result = await runAgentTurn(session, 'Read big.txt twice.');
  assert.equal(result.finished, true);
  const contents = toolContents(model.payloads[2]);
  assert.equal(contents.length, 2);
  assert.ok(contents[0].includes('line 199'), 'first read carries the full content');
  assert.ok(!contents[1].includes('line 199'), 'second read must not resend the content');
  assert.match(contents[1], /unchanged/);
  assert.ok(session.readDedupSavedBytes > 1000);
});

test('a changed file or disabled dedup always returns fresh content', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dedup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'big.txt');
  await writeFile(file, Array.from({ length: 200 }, (_, i) => 'v1 line ' + i).join('\n'));
  const done = { role: 'assistant', content: 'done' };
  const model = await scriptedModel(t, [read('a1'), done, read('a2'), done]);
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + model.port + '/v1', model: 'fixture', apiKey: '', maxSteps: 5 } });
  await runAgentTurn(session, 'Read big.txt.');
  await writeFile(file, Array.from({ length: 200 }, (_, i) => 'v2 line ' + i).join('\n'));
  await runAgentTurn(session, 'Read big.txt again.');
  const contents = toolContents(model.payloads[3]);
  assert.ok(contents[1].includes('v2 line 199'), 'changed file is re-sent in full');

  const model2 = await scriptedModel(t, [read('b1'), read('b2'), { role: 'assistant', content: 'done' }]);
  const off = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + model2.port + '/v1', model: 'fixture', apiKey: '', maxSteps: 5, readDedup: false } });
  await runAgentTurn(off, 'Read big.txt twice.');
  const offContents = toolContents(model2.payloads[2]);
  assert.ok(offContents[1].includes('v2 line 199'), 'readDedup:false disables the optimisation');
});
