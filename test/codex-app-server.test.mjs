import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
function codexClient(child, { decide = () => 'accept', respond = null } = {}) {
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
      child.stdin.write(JSON.stringify({ id: message.id, result: respond ? respond(message) : { decision: decide(message) } }) + '\n');
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

test('review/start runs an inline review turn wrapped in review-mode items', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-appsrv-home-');
  const { config, requests } = await scriptedModel(t, [{ content: 'No issues found in the pending changes.' }]);
  const { child, stderr } = spawnServer(t, root, home, config);
  const client = codexClient(child);
  await client.call('initialize', { clientInfo: { name: 't' } });
  const { result } = await client.call('thread/start', { cwd: root });
  const threadId = result.thread.id;
  assert.equal((await client.call('review/start', { threadId, target: { type: 'commit', sha: 'not-a-sha;rm' } })).error.code, -32602);
  assert.equal((await client.call('review/start', { threadId, target: { type: 'baseBranch', branch: '--output=x' } })).error.code, -32602);
  const review = await client.call('review/start', { threadId, target: { type: 'uncommittedChanges' } });
  assert.ok(review.result, stderr() + JSON.stringify(review));
  assert.equal(review.result.reviewThreadId, threadId);
  const done = await client.until((note) => note.method === 'turn/completed');
  assert.equal(done.params.turn.status, 'completed');
  const items = client.notes.filter((note) => note.method === 'item/completed').map((note) => note.params.item);
  assert.equal(items[0].type, 'enteredReviewMode');
  assert.equal(items[0].review, 'current changes');
  const exited = items.find((item) => item.type === 'exitedReviewMode');
  assert.match(exited.review, /No issues found/);
  const order = client.notes.map((note) => note.method + ':' + (note.params.item ? note.params.item.type : ''));
  assert.ok(order.lastIndexOf('item/completed:exitedReviewMode') < order.indexOf('turn/completed:'));
  assert.match(JSON.stringify(requests[0].messages), /git diff HEAD/);
});

test('ask_user_question reaches experimentalApi clients as item/tool/requestUserInput', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-appsrv-home-');
  const { config, requests } = await scriptedModel(t, [
    toolCall('ask_1', 'ask_user_question', { question: 'Which port?', header: 'Port', options: [{ label: '8080', description: 'Default' }, '3000'] }),
    { content: 'Using 3000.' }
  ]);
  const { child, stderr } = spawnServer(t, root, home, config);
  const client = codexClient(child, { respond: (message) => message.method === 'item/tool/requestUserInput' ? { answers: { q1: { answers: ['3000'] } } } : { decision: 'accept' } });
  await client.call('initialize', { clientInfo: { name: 't' }, capabilities: { experimentalApi: true } });
  const { result } = await client.call('thread/start', { cwd: root });
  await client.call('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: 'pick a port' }] });
  const done = await client.until((note) => note.method === 'turn/completed');
  assert.equal(done.params.turn.status, 'completed', stderr());
  const asked = client.approvals.find((message) => message.method === 'item/tool/requestUserInput');
  assert.ok(asked, JSON.stringify(client.approvals));
  assert.equal(asked.params.threadId, result.thread.id);
  assert.equal(asked.params.itemId, 'ask_1');
  assert.equal(asked.params.isBlocking, true);
  assert.deepEqual(asked.params.questions, [{ id: 'q1', header: 'Port', question: 'Which port?', isOther: true, isSecret: false, options: [{ label: '8080', description: 'Default' }, { label: '3000', description: '' }] }]);
  assert.ok(client.notes.some((note) => note.method === 'serverRequest/resolved'));
  const answer = requests[1].messages.filter((message) => message.role === 'tool').at(-1).content;
  assert.match(answer, /"answered":true/);
  assert.match(answer, /3000/);
});

test('without experimentalApi the App Server never sends requestUserInput', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-appsrv-home-');
  const { config, requests } = await scriptedModel(t, [{ content: 'Done.' }]);
  const { child } = spawnServer(t, root, home, config);
  const client = codexClient(child);
  await client.call('initialize', { clientInfo: { name: 't' } });
  const { result } = await client.call('thread/start', { cwd: root });
  await client.call('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: 'hi' }] });
  await client.until((note) => note.method === 'turn/completed');
  const names = (requests[0].tools || []).map((tool) => tool.function && tool.function.name);
  assert.ok(names.includes('read_file'), 'tools were sent');
  assert.ok(!names.includes('ask_user_question'), 'the tool is hidden when nobody can answer');
});

test('thread lifecycle: compact, loaded list, archive and unarchive (keeping the name), unsubscribe, delete', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-appsrv-home-');
  const { config, requests } = await scriptedModel(t, [{ content: 'Hello there.' }, { content: '## Summary\nThe user said hello.' }, { content: 'More.' }]);
  const { child, stderr } = spawnServer(t, root, home, config);
  const client = codexClient(child);
  await client.call('initialize', { clientInfo: { name: 't' } });
  const { result } = await client.call('thread/start', { cwd: root });
  const threadId = result.thread.id;
  await client.call('turn/start', { threadId, input: [{ type: 'text', text: 'hello' }] });
  await client.until((note) => note.method === 'turn/completed');
  assert.deepEqual((await client.call('thread/name/set', { threadId, name: 'Greeting' })).result, {});
  assert.deepEqual((await client.call('thread/loaded/list', {})).result, { data: [threadId], nextCursor: null });

  const before = requests.length;
  assert.deepEqual((await client.call('thread/compact/start', { threadId })).result, {});
  const compacted = await client.until((note) => note.method === 'turn/completed' && note.params.turn.id !== client.notes.find((n) => n.method === 'turn/completed').params.turn.id);
  assert.equal(compacted.params.turn.status, 'completed', stderr() + JSON.stringify(compacted));
  assert.ok(client.notes.some((note) => note.method === 'item/completed' && note.params.item.type === 'contextCompaction'));
  assert.ok(client.notes.some((note) => note.method === 'thread/compacted' && note.params.threadId === threadId));
  assert.equal(requests.length, before + 1, 'one summary request');

  assert.deepEqual((await client.call('thread/archive', { threadId })).result, {});
  assert.ok(client.notes.some((note) => note.method === 'thread/archived' && note.params.threadId === threadId));
  assert.deepEqual((await client.call('thread/loaded/list', {})).result.data, []);
  assert.deepEqual((await client.call('thread/list', { cwd: root })).result.data.map((thread) => thread.id), []);
  const archived = (await client.call('thread/list', { cwd: root, archived: true })).result.data;
  assert.deepEqual(archived.map((thread) => [thread.id, thread.name]), [[threadId, 'Greeting']]);

  const back = (await client.call('thread/unarchive', { threadId, cwd: root })).result;
  assert.equal(back.thread.id, threadId);
  assert.equal(back.thread.name, 'Greeting');
  assert.deepEqual((await client.call('thread/list', { cwd: root })).result.data.map((thread) => thread.id), [threadId]);
  assert.equal((await client.call('thread/list', { cwd: root, searchTerm: 'nothing-like-this' })).result.data.length, 0);

  // Resume, then unsubscribe unloads it; a second unsubscribe reports notLoaded.
  await client.call('thread/resume', { threadId, cwd: root });
  assert.deepEqual((await client.call('thread/unsubscribe', { threadId })).result, { status: 'unsubscribed' });
  assert.deepEqual((await client.call('thread/unsubscribe', { threadId })).result, { status: 'notLoaded' });

  assert.deepEqual((await client.call('thread/delete', { threadId, cwd: root })).result, {});
  assert.ok(client.notes.some((note) => note.method === 'thread/deleted' && note.params.threadId === threadId));
  assert.equal((await client.call('thread/read', { threadId, cwd: root })).error.code, -32002);
});

test('skills/list reports built-in and repository skills with Codex scopes and SKILL.md paths', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t, 'oasis-appsrv-home-');
  await mkdir(path.join(root, '.agents', 'skills', 'deploy-notes'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', 'deploy-notes', 'SKILL.md'), '---\nname: deploy-notes\ndescription: Write deploy notes. Use when shipping.\n---\nSteps.\n');
  const { config } = await scriptedModel(t, [{ content: 'unused' }]);
  const { child } = spawnServer(t, root, home, config);
  const client = codexClient(child);
  await client.call('initialize', { clientInfo: { name: 't' } });
  const { result, error } = await client.call('skills/list', { cwds: [root] });
  assert.ok(result, JSON.stringify(error));
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].cwd, root);
  const repo = result.data[0].skills.find((skill) => skill.name === 'deploy-notes');
  assert.deepEqual({ scope: repo.scope, path: repo.path, enabled: repo.enabled, description: repo.description }, { scope: 'repo', path: path.join(root, '.agents', 'skills', 'deploy-notes', 'SKILL.md'), enabled: true, description: 'Write deploy notes. Use when shipping.' });
  const system = result.data[0].skills.filter((skill) => skill.scope === 'system');
  assert.ok(system.length > 0, 'built-in skills are listed');
  for (const skill of system) assert.ok(existsSync(skill.path), skill.path);
});
