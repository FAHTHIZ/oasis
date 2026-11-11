import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createCodexAppServer, commandText, inputToPrompt, permissionModeFor } from '../src/codex-app-server.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function tmp(t, prefix = 'oasis-appsrv-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A minimal Codex app-server client: JSONL without the "jsonrpc" field, as Codex sends it.
function codexClient(child, { decide = () => 'accept' } = {}) {
  let id = 100;
  const waiting = new Map();
  const notes = [];
  const approvals = [];
  const waiters = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method && Object.hasOwn(message, 'id')) {
      approvals.push(message);
      child.stdin.write(JSON.stringify({ id: message.id, result: { decision: decide(message) } }) + '\n');
    } else if (message.method) {
      notes.push(message);
      for (const waiter of waiters.splice(0)) waiter();
    } else if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  });
  const until = async (predicate) => {
    while (!notes.some(predicate)) await new Promise((resolve) => waiters.push(resolve));
    return notes.find(predicate);
  };
  return {
    notes, approvals, until,
    call(method, params) {
      const requestId = ++id;
      child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
      return new Promise((resolve) => waiting.set(requestId, resolve));
    },
    notify(method, params) { child.stdin.write(JSON.stringify({ method, params }) + '\n'); }
  };
}

function spawnServer(t, root, home, config) {
  const child = spawn(process.execPath, [CLI, 'app-server'], {
    cwd: root,
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', OASIS_REQUIRE_READ_BEFORE_EDIT: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, stderr: () => stderr };
}

test('oasis app-server runs a Codex-protocol turn: items, approvals, file diffs and resume', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-appsrv-home-');
  await writeFile(path.join(root, 'notes.txt'), 'one\n');
  const { config } = await scriptedModel(t, [
    toolCall('call_cmd', 'run_command', { command: process.execPath, args: ['-e', 'console.log("ran from app-server")'] }),
    toolCall('call_edit', 'write_file', { path: 'notes.txt', content: 'one\ntwo\n' }),
    (payload) => {
      const lastUser = [...payload.messages].reverse().find((message) => message.role === 'user');
      const text = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content);
      return { content: /and again/.test(text) ? 'Second turn reply.' : 'Ran it and updated notes.txt.' };
    }
  ]);
  const { child, stderr } = spawnServer(t, root, home, config);
  const client = codexClient(child);

  const early = await client.call('thread/start', { cwd: root });
  assert.equal(early.error.message, 'Not initialized');
  const init = await client.call('initialize', { clientInfo: { name: 'test_client', version: '1' } });
  assert.match(init.result.userAgent, /^oasis\//);
  assert.ok(init.result.platformOs);
  client.notify('initialized', {});
  assert.equal((await client.call('initialize', {})).error.message, 'Already initialized');

  const started = await client.call('thread/start', { cwd: root, approvalPolicy: 'on-request' });
  assert.ok(started.result, stderr() + JSON.stringify(started));
  const threadId = started.result.thread.id;
  assert.equal(started.result.cwd, root);
  assert.equal(started.result.model, 'fixture');
  assert.equal(started.result.thread.status.type, 'idle');
  await client.until((note) => note.method === 'thread/started');

  const turn = await client.call('turn/start', { threadId, input: [{ type: 'text', text: 'run it and edit notes' }] });
  assert.equal(turn.result.turn.status, 'inProgress');
  const done = await client.until((note) => note.method === 'turn/completed');
  assert.equal(done.params.turn.id, turn.result.turn.id);
  assert.equal(done.params.turn.status, 'completed', stderr() + JSON.stringify(done));

  const methods = client.notes.map((note) => note.method);
  assert.ok(methods.indexOf('turn/started') < methods.indexOf('turn/completed'));
  const completed = client.notes.filter((note) => note.method === 'item/completed').map((note) => note.params.item);
  assert.equal(completed[0].type, 'userMessage');
  const command = completed.find((item) => item.type === 'commandExecution');
  assert.equal(command.id, 'call_cmd');
  assert.equal(command.status, 'completed');
  assert.equal(command.exitCode, 0);
  assert.match(command.aggregatedOutput, /ran from app-server/);
  assert.match(command.command, /console\.log/);
  const change = completed.find((item) => item.type === 'fileChange');
  assert.equal(change.status, 'completed');
  assert.equal(change.changes[0].path, path.join(root, 'notes.txt'));
  assert.equal(change.changes[0].kind.type, 'update');
  assert.match(change.changes[0].diff, /\+two/);
  assert.equal(completed.at(-1).type, 'agentMessage');
  assert.match(completed.at(-1).text, /updated notes\.txt/);
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'one\ntwo\n');

  // The command asked through Codex's approval request, then the request was resolved.
  const commandApproval = client.approvals.find((message) => message.method === 'item/commandExecution/requestApproval');
  assert.ok(commandApproval, JSON.stringify(client.approvals.map((m) => m.method)));
  assert.equal(commandApproval.params.threadId, threadId);
  assert.equal(commandApproval.params.turnId, turn.result.turn.id);
  assert.equal(commandApproval.params.itemId, 'call_cmd');
  assert.ok(client.notes.some((note) => note.method === 'serverRequest/resolved' && note.params.requestId === commandApproval.id));

  // A saved thread is listed, read back with turns and resumed by a fresh server.
  const list = await client.call('thread/list', { cwd: root });
  assert.ok(list.result.data.some((thread) => thread.id === threadId));
  const read = await client.call('thread/read', { threadId, includeTurns: true });
  assert.equal(read.result.thread.turns[0].items[0].type, 'userMessage');
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));

  const second = spawnServer(t, root, home, config);
  const again = codexClient(second.child);
  await again.call('initialize', { clientInfo: { name: 'test_client' } });
  const resumed = await again.call('thread/resume', { threadId, cwd: root });
  assert.ok(resumed.result, second.stderr() + JSON.stringify(resumed));
  assert.equal(resumed.result.thread.id, threadId);
  assert.match(JSON.stringify(resumed.result.thread.turns), /run it and edit notes/);
  await again.call('turn/start', { threadId, input: [{ type: 'text', text: 'and again' }] });
  const finished = await again.until((note) => note.method === 'turn/completed');
  assert.equal(finished.params.turn.status, 'completed');
  assert.equal((await again.call('nope/method', {})).error.code, -32601);
});

test('a declined Codex approval marks the command item declined and runs nothing', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-appsrv-home-');
  const { config } = await scriptedModel(t, [toolCall('call_1', 'run_command', { command: process.execPath, args: ['-e', 'require("fs").writeFileSync("no.txt", "x")'] }), { content: 'Okay, not writing.' }]);
  const { child } = spawnServer(t, root, home, config);
  const client = codexClient(child, { decide: () => 'decline' });
  await client.call('initialize', { clientInfo: { name: 't' } });
  const { result } = await client.call('thread/start', { cwd: root });
  await client.call('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: 'write no.txt' }] });
  await client.until((note) => note.method === 'turn/completed');
  await assert.rejects(() => readFile(path.join(root, 'no.txt'), 'utf8'));
  const item = client.notes.find((note) => note.method === 'item/completed' && note.params.item.type === 'commandExecution').params.item;
  assert.equal(item.status, 'declined');
});

test('protocol helpers map Codex inputs, commands and policies', async () => {
  assert.equal(commandText('run_command', { command: 'git', args: ['log', '--oneline', 'a b'] }), "git log --oneline 'a b'");
  assert.equal(commandText('run_shell', { command: 'ls -la | wc -l' }), 'ls -la | wc -l');
  const built = inputToPrompt([{ type: 'text', text: 'look' }, { type: 'mention', name: 'a', path: 'src/a.js' }, { type: 'image', url: 'data:image/png;base64,AAAA' }]);
  assert.equal(built.text, 'look\n\n@src/a.js');
  assert.deepEqual(built.images, [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.equal(permissionModeFor({ sandbox: 'read-only' }), 'plan');
  assert.equal(permissionModeFor({ approvalPolicy: 'never' }), 'auto');
  assert.equal(permissionModeFor({ approvalPolicy: 'on-request' }), 'default');
  assert.equal(permissionModeFor({}, 'acceptEdits'), 'acceptEdits');

  const out = [];
  const server = createCodexAppServer({ write: (line) => out.push(JSON.parse(line)), log: () => {}, env: { HOME: os.tmpdir() } });
  await server.receive('{nope');
  assert.equal(out[0].error.code, -32700);
  await server.receive(JSON.stringify({ method: 'initialized' }));
  assert.equal(out.length, 1, 'notifications get no reply');
  await server.receive(JSON.stringify({ id: 1, method: 'initialize', params: { capabilities: { optOutNotificationMethods: ['thread/started'] } } }));
  assert.ok(out[1].result.userAgent);
  await server.receive(JSON.stringify({ id: 2, method: 'turn/start', params: { threadId: 'missing', input: [] } }));
  assert.equal(out[2].error.code, -32002);
  await server.close();
});

test('thread/fork copies history into a new thread, optionally up to lastTurnId', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-appsrv-home-');
  const { config } = await scriptedModel(t, [(payload) => {
    const lastUser = [...payload.messages].reverse().find((message) => message.role === 'user');
    return { content: 'reply to ' + (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)).slice(-20) };
  }]);
  const { child, stderr } = spawnServer(t, root, home, config);
  const client = codexClient(child);
  await client.call('initialize', { clientInfo: { name: 't' } });
  const { result } = await client.call('thread/start', { cwd: root });
  const threadId = result.thread.id;
  for (const text of ['first question', 'second question']) {
    const before = client.notes.filter((note) => note.method === 'turn/completed').length;
    await client.call('turn/start', { threadId, input: [{ type: 'text', text }] });
    await client.until(() => client.notes.filter((note) => note.method === 'turn/completed').length > before);
  }
  const full = await client.call('thread/fork', { threadId });
  assert.ok(full.result, stderr() + JSON.stringify(full));
  assert.notEqual(full.result.thread.id, threadId);
  assert.equal(full.result.thread.forkedFromId, threadId);
  assert.equal(full.result.thread.turns.length, 2);
  const partial = await client.call('thread/fork', { threadId, lastTurnId: 'turn-1' });
  assert.equal(partial.result.thread.turns.length, 1);
  assert.match(JSON.stringify(partial.result.thread.turns), /first question/);
  assert.doesNotMatch(JSON.stringify(partial.result.thread.turns), /second question/);
  // The fork is its own saved thread; the original keeps both turns.
  const forkId = partial.result.thread.id;
  await client.call('turn/start', { threadId: forkId, input: [{ type: 'text', text: 'fork only' }] });
  await client.until((note) => note.method === 'turn/completed' && note.params.threadId === forkId);
  const original = await client.call('thread/read', { threadId, includeTurns: true });
  assert.equal(original.result.thread.turns.length, 2);
  assert.doesNotMatch(JSON.stringify(original.result.thread.turns), /fork only/);
  assert.equal((await client.call('thread/fork', { threadId, lastTurnId: 'abc' })).error.code, -32602);
});
