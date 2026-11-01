import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, isContextOverflowError, stopFailureType } from '../src/agent.mjs';

test('recognizes provider context-overflow errors', () => {
  for (const message of ['prompt is too long: 210000 tokens > 200000 maximum', "This model's maximum context length is 128000 tokens", 'context_length_exceeded', 'Input is too long for requested model', 'Request too large']) {
    assert.equal(isContextOverflowError(new Error(message)), true, message);
  }
  assert.equal(isContextOverflowError(Object.assign(new Error('x'), { status: 413 })), true);
  assert.equal(isContextOverflowError(new Error('max_tokens: 64000 > 32000, which is the maximum allowed')), false);
  assert.equal(isContextOverflowError(new Error('rate limited')), false);
  assert.equal(stopFailureType(new Error('prompt is too long')), 'context_overflow');
});

test('a too-long request is compacted and retried instead of ending the turn', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-overflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'huge.log'), Array.from({ length: 4000 }, (_, i) => 'log line ' + i + ' ' + 'x'.repeat(40)).join('\n'));
  let calls = 0;
  let rejected = 0;
  let rejectedLength = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    calls++;
    if (calls === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'huge.log' }) } }] } }] }));
      return;
    }
    if (calls === 2 || body.length >= rejectedLength) {
      rejected++;
      rejectedLength = rejectedLength || body.length;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'prompt is too long: 230000 tokens > 200000 maximum' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The log shows normal lines.' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  const events = [];
  const result = await runAgentTurn(session, 'what is in huge.log?', { autoApprove: true, onContextOverflow: (info) => events.push(info) });
  assert.equal(result.text, 'The log shows normal lines.');
  assert.ok(rejected >= 1);
  assert.ok(events.length >= 1 && events[0].afterChars < events[0].beforeChars);
});

test('a first request that overflows a small local window drops to the small-context tool set', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-overflow-first-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolCounts = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const tools = (JSON.parse(body).tools || []).length;
    toolCounts.push(tools);
    if (tools > 20) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 400, type: 'exceed_context_size_error', message: 'request (16695 tokens) exceeds the available context size (16384 tokens), try increasing it' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready.' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'local.gguf', apiKey: '', maxSteps: 3 } });
  const events = [];
  const result = await runAgentTurn(session, 'hello', { autoApprove: true, onContextOverflow: (info) => events.push(info) });
  assert.equal(result.text, 'Ready.');
  assert.ok(toolCounts[0] > 20 && toolCounts.at(-1) <= 20, toolCounts.join(','));
  assert.equal(session.config.contextWindow, 16384);
  assert.equal(events[0].smallContextTools, true);
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'tool_search'));
});
