import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { createStreamJsonChannel } from '../src/headless.mjs';

const require = createRequire(import.meta.url);
const { OasisChatProcess, translateEvent, splitCommand } = require('../ide/vscode/src/chat-process.js');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-chat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function collect(proc) {
  const events = [];
  const waiters = [];
  proc.on('ui', (event) => { events.push(event); for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); } });
  const waitFor = (match, ms = 15000) => {
    const hit = events.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timed out; events: ' + JSON.stringify(events.slice(-8)))), ms); waiters.push({ match, resolve: (event) => { clearTimeout(timer); resolve(event); } }); });
  };
  return { events, waitFor };
}

test('stream-json events become chat UI messages', () => {
  const state = { pending: new Map() };
  assert.deepEqual(translateEvent({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/w', permission_mode: 'default' }, state), [{ kind: 'init', model: 'm', cwd: '/w', permissionMode: 'default' }]);
  assert.deepEqual(translateEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }), [{ kind: 'delta', text: 'Hi' }]);
  assert.equal(translateEvent({ type: 'tool_use', name: 'read_file', input: { path: 'a.js' } })[0].summary, 'read_file · a.js');
  const [perm] = translateEvent({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'run_command', message: 'Run ls', permission_suggestions: ['Bash(ls:*)'] } }, state);
  assert.equal(perm.kind, 'permission');
  assert.equal(perm.canAlways, true);
  assert.ok(state.pending.has('r1'));
  assert.deepEqual(translateEvent({ type: 'result', subtype: 'turn', result: 'x' }).map((e) => e.kind), ['turnEnd', 'busy']);
  assert.deepEqual(splitCommand('"/opt/my node/node" cli.mjs'), ['/opt/my node/node', 'cli.mjs']);
});

test('control channel routes prompts, permission answers and interrupts', async () => {
  const input = new PassThrough();
  const lines = (await import('node:readline')).createInterface({ input, crlfDelay: Infinity });
  const written = [];
  const channel = createStreamJsonChannel(lines, (event) => written.push(event));
  let interrupted = 0;
  channel.onInterrupt(() => { interrupted++; });
  const iterator = channel[Symbol.asyncIterator]();
  input.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
  assert.deepEqual(await iterator.next(), { value: 'hello', done: false });
  const answer = channel.request({ subtype: 'can_use_tool', tool_name: 'x' });
  assert.equal(written[0].type, 'control_request');
  input.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: written[0].request_id, response: { behavior: 'allow' } } }) + '\n');
  assert.equal((await answer).response.behavior, 'allow');
  input.write(JSON.stringify({ type: 'control_request', request_id: 'i1', request: { subtype: 'interrupt' } }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(interrupted, 1);
  assert.equal(written.at(-1).response.request_id, 'i1');
  input.end();
  assert.equal((await iterator.next()).done, true);
});

test('chat process drives a real OASIS session with inline approvals', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  const nodeWrite = (file) => ({ command: process.execPath, args: ['-e', "require('fs').writeFileSync('" + file + "','hi from chat')"] });
  const { config } = await scriptedModel(t, [(payload) => {
    const last = payload.messages.at(-1);
    if (last.role === 'tool') return { content: 'Finished.' };
    const text = JSON.stringify(last.content);
    if (/hello/.test(text)) return toolCall('c1', 'run_command', nodeWrite('hello.txt'));
    if (/nope/.test(text)) return toolCall('c2', 'run_command', nodeWrite('nope.txt'));
    return { content: 'Finished.' };
  }]);
  const proc = new OasisChatProcess({ command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(CLI), cwd: root, env: { OASIS_HOME: home, HOME: home, OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_NO_ANIMATION: '1', OASIS_IDE_PORT: '' } });
  t.after(() => proc.stop());
  const { events, waitFor } = collect(proc);
  proc.send('create hello.txt');
  const permission = await waitFor((event) => event.kind === 'permission');
  assert.equal(permission.tool, 'run_command');
  proc.respond(permission.requestId, 'allow');
  await waitFor((event) => event.kind === 'turnEnd');
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'hi from chat');
  assert.ok(events.some((event) => event.kind === 'delta' || event.kind === 'assistant'));
  assert.ok(events.some((event) => event.kind === 'tool' && event.name === 'run_command'));

  const before = events.length;
  proc.send('create nope.txt');
  const second = await waitFor((event) => event.kind === 'permission' && event.requestId !== permission.requestId);
  proc.respond(second.requestId, 'deny');
  await waitFor((event) => event.kind === 'turnEnd' && events.indexOf(event) > before);
  await assert.rejects(readFile(path.join(root, 'nope.txt'), 'utf8'));
});
