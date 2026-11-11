import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createAcpServer, promptFromBlocks, toolKind, ACP_PROTOCOL_VERSION } from '../src/acp.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function tmp(t, prefix = 'oasis-acp-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A minimal ACP client: sends requests, answers permission requests, records updates.
function editorClient(child, { permission = 'allow_once' } = {}) {
  let id = 0;
  const waiting = new Map();
  const updates = [];
  const permissions = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'session/update') updates.push(message.params.update);
    else if (message.method === 'session/request_permission') {
      permissions.push(message.params);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: permission } } }) + '\n');
    } else if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  });
  return {
    updates, permissions,
    call(method, params) {
      const requestId = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      return new Promise((resolve) => waiting.set(requestId, resolve));
    }
  };
}

test('oasis acp runs a prompt end to end: streams text, reports tool calls and asks for permission', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-acp-home-');
  const { config } = await scriptedModel(t, [
    toolCall('call_1', 'run_command', { command: process.execPath, args: ['-e', 'require("fs").writeFileSync("hello.txt", "hi from acp\\n")'] }),
    { content: 'Created hello.txt.' }
  ]);
  const child = spawn(process.execPath, [CLI, 'acp'], {
    cwd: root,
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', OASIS_REQUIRE_READ_BEFORE_EDIT: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = editorClient(child);
  const init = await client.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  assert.equal(init.result.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.equal(init.result.agentCapabilities.loadSession, true);
  const created = await client.call('session/new', { cwd: root, mcpServers: [] });
  assert.ok(created.result, stderr + JSON.stringify(created));
  const sessionId = created.result.sessionId;
  assert.ok(created.result.modes.availableModes.some((mode) => mode.id === 'plan'));
  const done = await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'create hello.txt' }] });
  assert.equal(done.result && done.result.stopReason, 'end_turn', stderr + JSON.stringify(done));
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'hi from acp\n');
  assert.equal(client.permissions.length, 1);
  assert.ok(client.permissions[0].options.some((option) => option.kind === 'allow_once'));
  const call = client.updates.find((item) => item.sessionUpdate === 'tool_call');
  assert.equal(call.kind, 'execute');
  assert.equal(call.toolCallId, 'call_1');
  const finished = client.updates.find((item) => item.sessionUpdate === 'tool_call_update');
  assert.equal(finished.toolCallId, call.toolCallId);
  assert.equal(finished.status, 'completed');
  assert.match(client.updates.filter((item) => item.sessionUpdate === 'agent_message_chunk').map((item) => item.content.text).join(''), /Created hello\.txt/);
  const mode = await client.call('session/set_mode', { sessionId, modeId: 'acceptEdits' });
  assert.deepEqual(mode.result, {});
  const bad = await client.call('session/new', { cwd: 'relative/dir' });
  assert.equal(bad.error.code, -32602);
  const unknown = await client.call('nope', {});
  assert.equal(unknown.error.code, -32601);
});

test('a rejected permission leaves files untouched', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-acp-home-');
  const { config } = await scriptedModel(t, [toolCall('call_1', 'run_command', { command: process.execPath, args: ['-e', 'require("fs").writeFileSync("no.txt", "x")'] }), { content: 'Okay, not writing.' }]);
  const child = spawn(process.execPath, [CLI, 'acp'], { cwd: root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', OASIS_REQUIRE_READ_BEFORE_EDIT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const client = editorClient(child, { permission: 'reject_once' });
  await client.call('initialize', { protocolVersion: 1 });
  const { result } = await client.call('session/new', { cwd: root, mcpServers: [] });
  const done = await client.call('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'write no.txt' }] });
  assert.equal(done.result.stopReason, 'end_turn');
  await assert.rejects(() => readFile(path.join(root, 'no.txt'), 'utf8'));
  assert.equal(client.updates.find((item) => item.sessionUpdate === 'tool_call_update').status, 'failed');
});

test('prompt blocks map resource links to @mentions and embed resources as context', () => {
  const root = path.resolve('/work/app');
  const built = promptFromBlocks([
    { type: 'text', text: 'explain' },
    { type: 'resource_link', uri: 'file://' + path.join(root, 'src', 'a.js'), name: 'a.js' },
    { type: 'resource', resource: { uri: 'file:///x/notes.md', text: 'note body' } },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' }
  ], root);
  assert.match(built.text, /@src\/a\.js/);
  assert.match(built.text, /<context uri="file:\/\/\/x\/notes.md">\nnote body/);
  assert.deepEqual(built.images, [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.equal(toolKind('run_command'), 'execute');
  assert.equal(toolKind('read_file'), 'read');
});

test('the server answers parse errors and ignores notifications for unknown sessions', async () => {
  const out = [];
  const server = createAcpServer({ write: (line) => out.push(JSON.parse(line)), log: () => {} });
  await server.receive('{not json');
  assert.equal(out[0].error.code, -32700);
  await server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'x' } }));
  assert.equal(out.length, 1);
  // Requests before initialize are refused, as the protocol requires.
  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'session/prompt', params: { sessionId: 'missing', prompt: [] } }));
  assert.equal(out[1].id, 6);
  assert.equal(out[1].error.code, -32600);
  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }));
  assert.equal(out[2].result.protocolVersion, 1);
  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: 'missing', prompt: [] } }));
  assert.equal(out[3].id, 7);
  assert.equal(out[3].error.code, -32002);
  // Malformed params are rejected by the SDK's schema validation before OASIS sees them.
  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'session/new', params: { cwd: 42 } }));
  assert.equal(out[4].id, 8);
  assert.equal(out[4].error.code, -32602);
  await server.close();
});

test('ACP clients with fs capabilities serve unsaved buffers, receive writes and get inline diffs', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-acp-home-');
  const { writeFile: write } = await import('node:fs/promises');
  await write(path.join(root, 'a.txt'), 'on disk\n');
  const seen = [];
  const { config } = await scriptedModel(t, [
    toolCall('r1', 'read_file', { path: 'a.txt' }),
    (payload) => { seen.push(JSON.stringify(payload.messages)); return toolCall('e1', 'edit_file', { path: 'a.txt', old_string: 'unsaved buffer', new_string: 'edited buffer' }); },
    { content: 'Done.' }
  ]);
  const child = spawn(process.execPath, [CLI, 'acp'], { cwd: root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', OASIS_REQUIRE_READ_BEFORE_EDIT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const buffers = new Map([[path.join(root, 'a.txt'), 'unsaved buffer\n']]);
  const writes = [];
  const updates = [];
  let id = 0;
  const waiting = new Map();
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'fs/read_text_file') send({ id: message.id, result: { content: buffers.get(message.params.path) ?? '' } });
    else if (message.method === 'fs/write_text_file') { writes.push(message.params); buffers.set(message.params.path, message.params.content); send({ id: message.id, result: null }); }
    else if (message.method === 'session/request_permission') send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
    else if (message.method === 'session/update') updates.push(message.params.update);
    else if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  });
  const call = (method, params) => { const requestId = ++id; send({ id: requestId, method, params }); return new Promise((resolve) => waiting.set(requestId, resolve)); };
  await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
  const { result } = await call('session/new', { cwd: root, mcpServers: [] });
  const done = await call('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'edit a.txt' }] });
  assert.equal(done.result.stopReason, 'end_turn');
  assert.match(seen[0], /unsaved buffer/);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'edited buffer\n');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, path.join(root, 'a.txt'));
  assert.equal(writes[0].content, 'edited buffer\n');
  const edit = updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'e1');
  const diff = edit.content.find((c) => c.type === 'diff');
  assert.ok(diff, JSON.stringify(edit));
  // The "before" side is the unsaved buffer the agent edited, not the stale disk copy.
  assert.equal(diff.oldText, 'unsaved buffer\n');
  assert.equal(diff.newText, 'edited buffer\n');
});

test('ACP editor terminals (opt-in) run approved commands in the editor and embed the terminal', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-acp-home-');
  const { config } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: 'node', args: ['-e', 'console.log("hi from the editor")'] }),
    { content: 'Done.' }
  ]);
  const child = spawn(process.execPath, [CLI, 'acp', '--editor-terminal'], { cwd: root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const terminals = new Map();
  const calls = [];
  const updates = [];
  const permissions = [];
  let id = 0;
  const waiting = new Map();
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method && message.method.startsWith('terminal/')) {
      calls.push(message.method);
      const p = message.params;
      if (message.method === 'terminal/create') {
        const proc = spawn(p.command, p.args, { cwd: p.cwd, env: { ...process.env, ...Object.fromEntries((p.env || []).map((e) => [e.name, e.value])) } });
        const record = { output: '', exit: null };
        record.done = new Promise((resolve) => { proc.stdout.on('data', (d) => { record.output += d; }); proc.on('close', (code) => { record.exit = { exitCode: code, signal: null }; resolve(record.exit); }); });
        terminals.set('term-1', record);
        send({ id: message.id, result: { terminalId: 'term-1' } });
      } else if (message.method === 'terminal/wait_for_exit') terminals.get(p.terminalId).done.then((exit) => send({ id: message.id, result: exit }));
      else if (message.method === 'terminal/output') { const r = terminals.get(p.terminalId); send({ id: message.id, result: { output: r.output, truncated: false, exitStatus: r.exit } }); }
      else send({ id: message.id, result: null });
    } else if (message.method === 'session/request_permission') { permissions.push(message.params); send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }); }
    else if (message.method === 'session/update') updates.push(message.params.update);
    else if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  });
  const call = (method, params) => { const requestId = ++id; send({ id: requestId, method, params }); return new Promise((resolve) => waiting.set(requestId, resolve)); };
  await call('initialize', { protocolVersion: 1, clientCapabilities: { terminal: true } });
  const { result } = await call('session/new', { cwd: root, mcpServers: [] });
  const done = await call('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'say hi' }] });
  assert.equal(done.result.stopReason, 'end_turn');
  assert.equal(permissions.length, 1, 'the command still needed approval');
  assert.match(JSON.stringify(permissions[0]), /editor's terminal/);
  assert.deepEqual(calls, ['terminal/create', 'terminal/wait_for_exit', 'terminal/output', 'terminal/release']);
  const final = updates.filter((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'c1').at(-1);
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.content[0], { type: 'terminal', terminalId: 'term-1' });
  assert.match(JSON.stringify(final.content), /hi from the editor/);
});


test('ACP session lifecycle: list, resume, config options, usage and title updates, close and delete', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-acp-home-');
  const { config } = await scriptedModel(t, [{ content: 'First answer.' }, { content: 'Second answer.' }]);
  const child = spawn(process.execPath, [CLI, 'acp'], {
    cwd: root,
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', OASIS_CONTEXT_WINDOW: '100000' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = editorClient(child);
  const init = await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(init.result.agentCapabilities.sessionCapabilities, { list: {}, resume: {}, close: {}, delete: {} });

  const created = await client.call('session/new', { cwd: root, mcpServers: [] });
  assert.ok(created.result, stderr + JSON.stringify(created));
  const sessionId = created.result.sessionId;
  const options = created.result.configOptions;
  const modeOption = options.find((option) => option.id === 'mode');
  assert.equal(modeOption.category, 'mode');
  assert.equal(modeOption.type, 'select');
  assert.ok(modeOption.options.some((option) => option.value === 'plan'));
  const modelOption = options.find((option) => option.id === 'model');
  assert.equal(modelOption.currentValue, 'fixture');

  const done = await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Explain the   build setup' }] });
  assert.equal(done.result.stopReason, 'end_turn', stderr + JSON.stringify(done));
  const usage = client.updates.find((item) => item.sessionUpdate === 'usage_update');
  assert.ok(usage, 'expected a usage_update: ' + JSON.stringify(client.updates.map((item) => item.sessionUpdate)));
  assert.equal(usage.size, 100000);
  assert.ok(usage.used > 0);
  const info = client.updates.find((item) => item.sessionUpdate === 'session_info_update');
  assert.equal(info.title, 'Explain the build setup');

  const setMode = await client.call('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' });
  assert.equal(setMode.result.configOptions.find((option) => option.id === 'mode').currentValue, 'plan');
  assert.ok(client.updates.some((item) => item.sessionUpdate === 'current_mode_update' && item.currentModeId === 'plan'));
  const badModel = await client.call('session/set_config_option', { sessionId, configId: 'model', value: 'not-allowed' });
  assert.equal(badModel.error.code, -32602);
  const badOption = await client.call('session/set_config_option', { sessionId, configId: 'nope', value: 'x' });
  assert.equal(badOption.error.code, -32602);
  await client.call('session/set_config_option', { sessionId, configId: 'mode', value: 'default' });

  const listed = await client.call('session/list', { cwd: root });
  assert.ok(listed.result.sessions.some((item) => item.sessionId === sessionId && item.cwd === root && /Explain the build setup/.test(item.title || '')), JSON.stringify(listed));
  assert.equal(listed.result.nextCursor, null);
  // Archiving (App Server thread/archive, oasis sessions archive) hides it here too.
  const { setSessionArchived } = await import('../src/sessions.mjs');
  const sessionEnv = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  await setSessionArchived(root, sessionId, true, { env: sessionEnv });
  assert.equal((await client.call('session/list', { cwd: root })).result.sessions.some((item) => item.sessionId === sessionId), false);
  await setSessionArchived(root, sessionId, false, { env: sessionEnv });

  const closed = await client.call('session/close', { sessionId });
  assert.deepEqual(closed.result, {});
  const afterClose = await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal(afterClose.error.code, -32002);

  // resume reopens without replaying the conversation
  const before = client.updates.length;
  const resumed = await client.call('session/resume', { sessionId, cwd: root, mcpServers: [] });
  assert.ok(resumed.result.configOptions, JSON.stringify(resumed));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.updates.slice(before).filter((item) => item.sessionUpdate === 'user_message_chunk').length, 0);
  const second = await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'and the tests?' }] });
  assert.equal(second.result.stopReason, 'end_turn');
  assert.equal(client.updates.slice(before).filter((item) => item.sessionUpdate === 'session_info_update').length, 0, 'title is only sent after the first prompt');

  const deleted = await client.call('session/delete', { sessionId });
  assert.deepEqual(deleted.result, {});
  const relisted = await client.call('session/list', { cwd: root });
  assert.equal(relisted.result.sessions.some((item) => item.sessionId === sessionId), false);
  const again = await client.call('session/delete', { sessionId, cwd: root });
  assert.equal(again.error.code, -32002);
});

test('ACP elicitation: ask_user_question becomes an elicitation/create form when the client supports it', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-acp-home-');
  const { config, requests } = await scriptedModel(t, [
    toolCall('q1', 'ask_user_question', { question: 'Which database should I use?', header: 'Database', options: [{ label: 'SQLite', description: 'File-based' }, 'Postgres'] }),
    { content: 'Using SQLite.' },
    toolCall('q2', 'ask_user_question', { question: 'Which test runner?', options: ['node:test', 'vitest'] }),
    { content: 'Picked one myself.' }
  ]);
  const child = spawn(process.execPath, [CLI, 'acp'], {
    cwd: root,
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const elicitations = [];
  const replies = [{ action: 'accept', content: { answer: 'SQLite' } }, { action: 'decline' }];
  let id = 0;
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'elicitation/create') {
      elicitations.push(message.params);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: replies.shift() }) + '\n');
    } else if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  });
  const call = (method, params) => { const requestId = ++id; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); return new Promise((resolve) => waiting.set(requestId, resolve)); };
  await call('initialize', { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
  const created = await call('session/new', { cwd: root, mcpServers: [] });
  const sessionId = created.result.sessionId;
  const first = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'set up storage' }] });
  assert.equal(first.result && first.result.stopReason, 'end_turn', stderr + JSON.stringify(first));
  assert.equal(elicitations.length, 1);
  const form = elicitations[0];
  assert.equal(form.mode, 'form');
  assert.equal(form.sessionId, sessionId);
  assert.equal(form.toolCallId, 'q1');
  assert.equal(form.message, 'Which database should I use?');
  assert.deepEqual(form.requestedSchema.properties.answer.oneOf, [{ const: 'SQLite', title: 'SQLite', description: 'File-based' }, { const: 'Postgres', title: 'Postgres' }]);
  assert.equal(form.requestedSchema.properties.answer.title, 'Database');
  const toolResult = (request) => request.messages.filter((message) => message.role === 'tool').at(-1).content;
  assert.match(toolResult(requests[1]), /"answered":true/);
  assert.match(toolResult(requests[1]), /SQLite/);

  // A declined form tells the model to decide for itself.
  const second = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'add tests' }] });
  assert.equal(second.result && second.result.stopReason, 'end_turn', stderr + JSON.stringify(second));
  assert.equal(elicitations.length, 2);
  assert.match(toolResult(requests[3]), /did not answer/);
});

test('ACP $/cancel_request for a running prompt stops the turn with stopReason cancelled', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-acp-home-');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const modelReached = new Promise((resolve) => { reached = resolve; });
  const { config } = await scriptedModel(t, [async () => { reached(); await held; return { content: 'too late' }; }]);
  t.after(() => release());
  const child = spawn(process.execPath, [CLI, 'acp'], {
    cwd: root,
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = editorClient(child);
  await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const created = await client.call('session/new', { cwd: root, mcpServers: [] });
  const sessionId = created.result.sessionId;
  const running = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'wait' }] });
  await modelReached;
  // editorClient numbers requests from 1: initialize=1, session/new=2, session/prompt=3.
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 3 } }) + '\n');
  const done = await running;
  assert.equal(done.result && done.result.stopReason, 'cancelled', stderr + JSON.stringify(done));
  // The session is free for the next prompt.
  release();
  const again = await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] });
  assert.ok(again.result, stderr + JSON.stringify(again));
});

test('ACP model changes run PreModelSwitch with source "sdk"; a blocking hook returns an error', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-acp-home-');
  const seen = path.join(home, 'pre.json');
  const hook = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify('let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",()=>{require("fs").writeFileSync(' + JSON.stringify(seen) + ',s);if(JSON.parse(s).to_model==="claude-opus-4-6"){process.stderr.write("Opus 4.6 is retired.");process.exit(2)}})');
  await mkdir(path.join(home, 'cfg'), { recursive: true });
  await writeFile(path.join(home, 'cfg', 'settings.json'), JSON.stringify({ availableModels: ['fixture', 'claude-opus-4-6', 'claude-sonnet-5'], hooks: { PreModelSwitch: [{ hooks: [{ type: 'command', command: hook }] }] } }));
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const child = spawn(process.execPath, [CLI, 'acp'], {
    cwd: root,
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  const client = editorClient(child);
  await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const created = await client.call('session/new', { cwd: root, mcpServers: [] });
  const sessionId = created.result.sessionId;
  const blocked = await client.call('session/set_config_option', { sessionId, configId: 'model', value: 'claude-opus-4-6' });
  assert.ok(blocked.error, JSON.stringify(blocked));
  assert.equal(blocked.error.code, -32000);
  assert.match(blocked.error.message, /Opus 4\.6 is retired/);
  const input = JSON.parse(await readFile(seen, 'utf8'));
  assert.equal(input.source, 'sdk');
  assert.equal(input.from_model, 'fixture');
  const allowed = await client.call('session/set_config_option', { sessionId, configId: 'model', value: 'claude-sonnet-5' });
  assert.equal(allowed.result.configOptions.find((option) => option.id === 'model').currentValue, 'claude-sonnet-5');
});
