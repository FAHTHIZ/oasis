import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  normalizePart, normalizeState, stateTo03, normalizeMessage, buildAgentCard, pickInterface, createA2aCore, createA2aHttpServer,
  A2aClient, fetchAgentCard, configuredA2aAgents, executeRemoteAgentTool, remoteAgentToolDefinition, serveA2a, A2A_ERRORS
} from '../src/a2a.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

test('0.3 and 1.0 protocol objects normalize to 1.0', () => {
  assert.deepEqual(normalizePart({ kind: 'text', text: 'hi' }), { text: 'hi' });
  assert.deepEqual(normalizePart({ text: 'hi' }), { text: 'hi' });
  assert.deepEqual(normalizePart({ kind: 'file', file: { name: 'a.png', mimeType: 'image/png', bytes: 'AAA' } }), { raw: 'AAA', filename: 'a.png', mediaType: 'image/png' });
  assert.deepEqual(normalizePart({ kind: 'data', data: { a: 1 } }), { data: { a: 1 }, mediaType: 'application/json' });
  assert.equal(normalizePart({ kind: 'mystery' }), null);
  assert.equal(normalizeState('input-required'), 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(normalizeState('cancelled'), 'TASK_STATE_CANCELED');
  assert.equal(stateTo03('TASK_STATE_AUTH_REQUIRED'), 'auth-required');
  const message = normalizeMessage({ kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'x' }] });
  assert.equal(message.role, 'ROLE_USER');
});

test('the agent card serves 1.0 clients and still names the 0.3 endpoint', () => {
  const both = buildAgentCard({ url: 'http://127.0.0.1:1/', version: '1.7.1' });
  for (const key of ['name', 'description', 'supportedInterfaces', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) assert.ok(key in both, key);
  assert.equal(both.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(both.url, 'http://127.0.0.1:1/');
  assert.equal(both.securitySchemes.bearer.httpAuthSecurityScheme.scheme, 'Bearer');
  const pure = buildAgentCard({ url: 'http://x/', dialect: '1.0' });
  assert.equal(pure.url, undefined);
  assert.equal(pure.securitySchemes.bearer.type, undefined);
  assert.deepEqual(pickInterface(both), { url: 'http://127.0.0.1:1/', version: '1.0' });
  assert.deepEqual(pickInterface({ name: 'old', url: 'http://old/rpc', protocolVersion: '0.3.0' }), { url: 'http://old/rpc', version: '0.3' });
  assert.throws(() => pickInterface({ name: 'grpc only', supportedInterfaces: [{ url: 'grpc:1', protocolBinding: 'GRPC', protocolVersion: '1.0' }] }), /JSON-RPC/);
});

// A fake OASIS behind the real protocol code: scripted turns instead of a model.
function fakeAgent(script) {
  const started = [];
  return {
    started,
    startContext: async (contextId, { skill }) => {
      const turns = [];
      started.push({ contextId, skill, turns });
      return {
        run: async (text, hooks) => { turns.push(text); return await script(text, hooks); },
        close: () => { started.find((item) => item.contextId === contextId).closed = true; }
      };
    }
  };
}

async function startServer(t, script, { token = 'secret-token' } = {}) {
  const agent = fakeAgent(script);
  const core = createA2aCore({ startContext: agent.startContext, contextIdleMs: 0 });
  let url = '';
  const server = createA2aHttpServer({ core, token, card: (dialect) => buildAgentCard({ url, dialect, auth: Boolean(token) }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + server.address().port + '/';
  t.after(() => { core.close(); server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const rpc = async (method, params, headers = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });
    return { status: response.status, body: await response.json() };
  };
  const stream = async (method, params, headers = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method, params }) });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    return text.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)).result);
  };
  return { url, rpc, stream, agent, core };
}

const userMessage = (text, extra = {}) => ({ messageId: 'm-' + Math.random().toString(36).slice(2), role: 'ROLE_USER', parts: [{ text }], ...extra });

test('SendMessage (1.0) runs a turn and returns the completed task with its answer', async (t) => {
  const { url, rpc, agent } = await startServer(t, async (text) => ({ text: 'You said: ' + text }));
  const card = await (await fetch(url + '.well-known/agent-card.json', { headers: { 'A2A-Version': '1.0' } })).json();
  assert.equal(card.capabilities.streaming, true);
  const { body } = await rpc('SendMessage', { message: userMessage('hello') }, { 'A2A-Version': '1.0' });
  const task = body.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.artifacts[0].parts[0].text, 'You said: hello');
  assert.equal(task.history[0].role, 'ROLE_USER');
  // A follow-up in the same context reuses the same OASIS session.
  await rpc('SendMessage', { message: userMessage('again', { contextId: task.contextId }) }, { 'A2A-Version': '1.0' });
  assert.equal(agent.started.length, 1);
  assert.deepEqual(agent.started[0].turns, ['hello', 'again']);
  const listed = await rpc('ListTasks', { contextId: task.contextId }, { 'A2A-Version': '1.0' });
  assert.equal(listed.body.result.totalSize, 2);
  assert.equal(listed.body.result.nextPageToken, '');
});

test('message/send (0.3) gets 0.3 objects back', async (t) => {
  const { rpc } = await startServer(t, async () => ({ text: 'ok' }));
  const { body } = await rpc('message/send', { message: { kind: 'message', role: 'user', messageId: 'a', parts: [{ kind: 'text', text: 'hi' }] } });
  assert.equal(body.result.kind, 'task');
  assert.equal(body.result.status.state, 'completed');
  assert.deepEqual(body.result.artifacts[0].parts[0], { kind: 'text', text: 'ok' });
  const got = await rpc('tasks/get', { id: body.result.id });
  assert.equal(got.body.result.status.state, 'completed');
});

test('requests need the bearer token; errors use A2A codes', async (t) => {
  const { url, rpc } = await startServer(t, async () => ({ text: 'ok' }));
  const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }) });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /Bearer/);
  const wrong = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(wrong.status, 401);
  assert.equal((await rpc('GetTask', { id: 'missing' })).body.error.code, A2A_ERRORS.taskNotFound);
  assert.equal((await rpc('SendMessage', { message: userMessage('x') }, { 'A2A-Version': '0.5' })).body.error.code, A2A_ERRORS.versionNotSupported);
  assert.equal((await rpc('CreateTaskPushNotificationConfig', {})).body.error.code, A2A_ERRORS.pushNotSupported);
  assert.equal((await rpc('Nope', {})).body.error.code, A2A_ERRORS.methodNotFound);
  assert.equal((await rpc('SendMessage', { message: { role: 'ROLE_USER', parts: [] } })).body.error.code, A2A_ERRORS.invalidParams);
});

test('SendStreamingMessage streams the task, text chunks and the final status', async (t) => {
  const { stream } = await startServer(t, async (text, hooks) => {
    hooks.onTool('read_file');
    hooks.onDelta('Hel');
    hooks.onDelta('Hello wor');
    return { text: 'Hello world' };
  });
  const events = await stream('SendStreamingMessage', { message: userMessage('go') }, { 'A2A-Version': '1.0' });
  assert.ok(events[0].task, 'starts with the task');
  const chunks = events.filter((event) => event.artifactUpdate).map((event) => event.artifactUpdate);
  assert.equal(chunks.map((chunk) => chunk.artifact.parts[0].text).join(''), 'Hello world');
  assert.equal(chunks[0].append, false);
  assert.ok(chunks.slice(1).every((chunk) => chunk.append));
  assert.equal(chunks.at(-1).lastChunk, true);
  assert.ok(events.some((event) => event.statusUpdate && /read_file/.test(JSON.stringify(event.statusUpdate.status.message || ''))));
  assert.equal(events.at(-1).statusUpdate.status.state, 'TASK_STATE_COMPLETED');

  const legacy = await stream('message/stream', { message: { kind: 'message', role: 'user', messageId: 'z', parts: [{ kind: 'text', text: 'go' }] } });
  assert.equal(legacy[0].kind, 'task');
  assert.equal(legacy.at(-1).kind, 'status-update');
  assert.equal(legacy.at(-1).final, true);
  assert.equal(legacy.at(-1).status.state, 'completed');
});

test('an approval pauses the task as input-required and the next message answers it', async (t) => {
  const seen = [];
  const { rpc } = await startServer(t, async (text, hooks) => {
    const allowed = await hooks.approval('Run command: npm test?');
    seen.push(allowed);
    const name = await hooks.askUser('Which branch?');
    return { text: 'allowed=' + allowed + ' branch=' + name };
  });
  const first = (await rpc('SendMessage', { message: userMessage('test it') }, { 'A2A-Version': '1.0' })).body.result.task;
  assert.equal(first.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(first.status.message.parts[0].text, /npm test[\s\S]*yes/);
  const second = (await rpc('SendMessage', { message: userMessage('yes', { taskId: first.id, contextId: first.contextId }) }, { 'A2A-Version': '1.0' })).body.result.task;
  assert.equal(second.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(second.status.message.parts[0].text, /Which branch/);
  const done = (await rpc('SendMessage', { message: userMessage('main', { taskId: first.id }) }, { 'A2A-Version': '1.0' })).body.result.task;
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(done.artifacts[0].parts[0].text, 'allowed=true branch=main');
  assert.deepEqual(seen, [true]);
  // A finished task takes no more input.
  assert.equal((await rpc('SendMessage', { message: userMessage('more', { taskId: first.id }) })).body.error.code, A2A_ERRORS.unsupported);
});

test('CancelTask stops a running turn', async (t) => {
  let aborted = false;
  const { rpc } = await startServer(t, (text, hooks) => new Promise((resolve) => {
    hooks.signal.addEventListener('abort', () => { aborted = true; resolve({ text: 'stopped' }); });
  }));
  const task = (await rpc('SendMessage', { message: userMessage('long job'), configuration: { returnImmediately: true } }, { 'A2A-Version': '1.0' })).body.result.task;
  assert.ok(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const canceled = (await rpc('CancelTask', { id: task.id })).body.result;
  assert.equal(canceled.status.state, 'TASK_STATE_CANCELED');
  assert.equal(aborted, true);
  assert.equal((await rpc('CancelTask', { id: task.id })).body.result.status.state, 'TASK_STATE_CANCELED', 'idempotent');
});

test('the client speaks both versions and the remote_agent tool delegates through it', async (t) => {
  const { url, agent } = await startServer(t, async (text) => ({ text: 'remote: ' + text }));
  const card = await fetchAgentCard(url, { token: 'secret-token' });
  for (const version of ['1.0', '0.3']) {
    const client = new A2aClient({ url: pickInterface(card).url, version, token: 'secret-token' });
    const reply = await client.send('ping ' + version);
    assert.equal(reply.task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(reply.task.artifacts[0].parts[0].text, 'remote: ping ' + version);
  }
  const agents = configuredA2aAgents({ a2aAgents: { helper: { url, token: 'secret-token', description: 'A test helper' }, 'bad name!': 'http://x', ftp: 'ftp://x' } }, {});
  assert.deepEqual([...agents.keys()], ['helper']);
  const definition = remoteAgentToolDefinition(agents);
  assert.deepEqual(definition.function.parameters.properties.agent.enum, ['helper']);
  const session = { a2aAgents: agents };
  const asked = [];
  const context = { session, env: {}, approval: async (message) => { asked.push(message); return true; } };
  const first = await executeRemoteAgentTool({ agent: 'helper', message: 'summarize X' }, context);
  assert.equal(first.state, 'completed');
  assert.equal(first.result, 'remote: summarize X');
  const followUp = await executeRemoteAgentTool({ agent: 'helper', message: 'and Y', context_id: first.context_id }, context);
  assert.equal(followUp.result, 'remote: and Y');
  assert.equal(asked.length, 1, 'asks once per agent per session');
  assert.match(asked[0], /remote agent "helper" at 127\.0\.0\.1/);
  assert.equal(agent.started.length, 3, 'two client contexts plus one tool conversation');
  const info = await executeRemoteAgentTool({ agent: 'helper', action: 'card' }, context);
  assert.equal(info.protocol, '1.0');
  const refused = await executeRemoteAgentTool({ agent: 'helper', message: 'x' }, { session: { a2aAgents: agents }, env: {}, approval: async () => false });
  assert.match(refused.error, /did not allow/);
  assert.match((await executeRemoteAgentTool({ agent: 'nobody', message: 'x' }, context)).error, /Unknown remote agent/);
});

test('oasis a2a serve runs a real OASIS session per context', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-a2a-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [{ content: 'Hello from OASIS.' }]);
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_NEURON_LEDGER: '0', OASIS_PROTOCOL: config.protocol, OASIS_BASE_URL: config.baseURL, OASIS_MODEL: config.model, OASIS_API_KEY: 'x', OASIS_A2A_TOKEN: 'tok' };
  await assert.rejects(serveA2a({ root, env, host: '0.0.0.0', port: 0, noAuth: true }), /only allowed on localhost/);
  const server = await serveA2a({ root, env, port: 0, version: '9.9.9' });
  t.after(() => server.close());
  assert.equal(server.token, 'tok');
  const card = await fetchAgentCard(server.url);
  assert.equal(card.version, '9.9.9');
  assert.ok(card.skills.some((skill) => skill.id === 'oasis'));
  const client = new A2aClient({ url: pickInterface(card).url, token: 'tok' });
  const reply = await client.send('Say hello.');
  assert.equal(reply.task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(reply.task.status));
  assert.equal(reply.task.artifacts[0].parts[0].text, 'Hello from OASIS.');
});
