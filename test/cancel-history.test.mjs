import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

test('stopping a turn mid-reply keeps the request and the partial reply in history', async (t) => {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: 'Step one: open the config file' } }] }));
    // Never finishes; the client cancels.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cancel-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const turn = runAgentTurn(session, 'explain the setup steps', {
    signal: controller.signal,
    onDelta: (text) => { if (text.includes('config file')) controller.abort(); }
  });
  await assert.rejects(turn, (error) => error.name === 'AbortError' || /cancel/i.test(error.message));
  const user = session.messages.filter((message) => message.role === 'user').at(-1);
  assert.match(String(user.content), /explain the setup steps/);
  const last = session.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.match(last.content, /^Step one: open the config file/);
  assert.match(last.content, /interrupted by the user/);
});

test('an interrupted request still reports estimated usage for /cost and the budget', async (t) => {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: 'Step one: open the config file' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cancel-usage-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const usages = [];
  const turn = runAgentTurn(session, 'explain the setup steps', {
    signal: controller.signal,
    onUsage: (usage) => usages.push(usage),
    onDelta: (text) => { if (text.includes('config file')) controller.abort(); }
  });
  await assert.rejects(turn);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].estimated, true);
  assert.equal(usages[0].interrupted, true);
  assert.ok(usages[0].inputTokens > 100, 'the prompt (system, tools, request) counts');
  assert.ok(usages[0].outputTokens > 0, 'the shown output counts');
  assert.equal(usages[0].phase, undefined, 'counted as a model request');
});

test('a request stopped before the provider answered reports no usage', async (t) => {
  const server = createServer(async (req) => { for await (const chunk of req) void chunk; /* never answers */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cancel-nousage-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const usages = [];
  const turn = runAgentTurn(session, 'hello', { signal: controller.signal, onUsage: (usage) => usages.push(usage), onDelta: () => {} });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(turn);
  assert.equal(usages.length, 0);
});
