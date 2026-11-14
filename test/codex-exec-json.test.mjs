import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { createCodexExecJsonStream, parseCodexConfigValue, codexEffort } from '../src/codex-exec-json.mjs';
import { readSmall, LARGE_FILE } from '../src/codex-app-server.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

// Spawns OASIS exactly the way @openai/codex-sdk spawns `codex exec`
// (sdk/typescript/src/exec.ts): flags, then optional `resume ID`, prompt on stdin.
function runLikeCodexSdk({ root, env, input, threadId = null, options = {} }) {
  const args = ['exec', '--experimental-json'];
  if (options.model) args.push('--model', options.model);
  if (options.sandboxMode) args.push('--sandbox', options.sandboxMode);
  args.push('--cd', root, '--skip-git-repo-check');
  if (options.outputSchemaFile) args.push('--output-schema', options.outputSchemaFile);
  if (options.approvalPolicy) args.push('--config', 'approval_policy="' + options.approvalPolicy + '"');
  if (options.effort) args.push('--config', 'model_reasoning_effort="' + options.effort + '"');
  if (threadId) args.push('resume', threadId);
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(input);
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  return new Promise((resolve) => child.on('close', (code) => {
    const events = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    resolve({ code, err, events });
  }));
}

// Thread.run() aggregation from the SDK (sdk/typescript/src/thread.ts).
function sdkRun(events) {
  let threadId = null;
  let finalResponse = '';
  let usage = null;
  let failure = null;
  const items = [];
  for (const event of events) {
    if (event.type === 'thread.started') threadId = event.thread_id;
    else if (event.type === 'item.completed') { items.push(event.item); if (event.item.type === 'agent_message') finalResponse = event.item.text; }
    else if (event.type === 'turn.completed') usage = event.usage;
    else if (event.type === 'turn.failed') failure = event.error;
  }
  return { threadId, finalResponse, usage, failure, items };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-codex-exec-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-codex-exec-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  return { root, home };
}

const envFor = (home, config) => ({ ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', OASIS_PROGRESS: '0' });

test('oasis exec --experimental-json speaks the Codex SDK event stream and resumes threads', { skip: process.platform === 'win32' }, async (t) => {
  const { root, home } = await fixture(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: 'node', args: ['calc.js'] }),
    toolCall('c2', 'write_file', { path: 'answer.txt', content: '42\n' }),
    { content: 'The answer is 42.' },
    { content: 'Still 42.' }
  ]);
  const env = envFor(home, config);
  await writeFile(path.join(root, 'calc.js'), 'console.log(6 * 7);\n');
  const first = await runLikeCodexSdk({ root, env, input: 'compute 6*7 and save it', options: { sandboxMode: 'danger-full-access', approvalPolicy: 'never', effort: 'xhigh' } });
  assert.equal(first.code, 0, first.err);
  const types = first.events.map((event) => event.type);
  assert.equal(types[0], 'thread.started');
  assert.equal(types[1], 'turn.started');
  assert.equal(types.at(-1), 'turn.completed');
  const run = sdkRun(first.events);
  assert.match(run.threadId, /^[0-9a-f-]{36}$/);
  assert.equal(run.finalResponse, 'The answer is 42.');
  assert.equal(run.failure, null);
  assert.equal(typeof run.usage.input_tokens, 'number');
  for (const key of ['cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens']) assert.equal(typeof run.usage[key], 'number', key);
  const command = run.items.find((item) => item.type === 'command_execution');
  assert.ok(command, JSON.stringify(run.items));
  assert.equal(command.status, 'completed');
  assert.equal(command.exit_code, 0);
  assert.match(command.aggregated_output, /42/);
  assert.equal(command.command, 'node calc.js');
  const started = first.events.find((event) => event.type === 'item.started' && event.item.type === 'command_execution');
  assert.equal(started.item.status, 'in_progress');
  assert.equal(started.item.id, command.id);
  const change = run.items.find((item) => item.type === 'file_change');
  assert.deepEqual(change.changes, [{ path: path.join(root, 'answer.txt'), kind: 'add' }]);
  assert.equal(change.status, 'completed');
  assert.equal(await readFile(path.join(root, 'answer.txt'), 'utf8'), '42\n');
  const ids = run.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'item ids are unique');

  // thread.resume(id).run(...) → `exec ... resume ID`: same thread, earlier context kept.
  const second = await runLikeCodexSdk({ root, env, input: 'and now?', threadId: run.threadId, options: { sandboxMode: 'read-only' } });
  assert.equal(second.code, 0, second.err);
  const resumed = sdkRun(second.events);
  assert.equal(resumed.threadId, run.threadId);
  assert.equal(resumed.finalResponse, 'Still 42.');
  const last = JSON.stringify(requests.at(-1).messages);
  assert.match(last, /compute 6\*7 and save it/);
  assert.match(last, /and now\?/);
});

test('exec --json with --output-schema ends with the JSON document as the final message', { skip: process.platform === 'win32' }, async (t) => {
  const { root, home } = await fixture(t);
  const { config } = await scriptedModel(t, [{ content: '{"answer":42}' }]);
  const schemaFile = path.join(root, 'schema.json');
  await writeFile(schemaFile, JSON.stringify({ type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false }));
  const result = await runLikeCodexSdk({ root, env: envFor(home, config), input: 'answer', options: { outputSchemaFile: schemaFile } });
  assert.equal(result.code, 0, result.err);
  const run = sdkRun(result.events);
  assert.deepEqual(JSON.parse(run.finalResponse), { answer: 42 });
});

test('exec --json reports setup errors as an error event and a non-zero exit', { skip: process.platform === 'win32' }, async (t) => {
  const { root, home } = await fixture(t);
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_BASE_URL: '', OASIS_MODEL: '', OASIS_PROTOCOL: '', OASIS_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OPENROUTER_API_KEY: '' };
  const result = await runLikeCodexSdk({ root, env, input: 'hello' });
  assert.notEqual(result.code, 0);
  assert.equal(result.events.at(-1).type, 'error');
  assert.match(result.events.at(-1).message, /provider/i);
  assert.match(result.err, /OASIS error/);
});

test('Codex exec stream maps MCP, todo, web search and failures', () => {
  let text = '';
  const stream = createCodexExecJsonStream({ write: (chunk) => { text += chunk; }, root: '/tmp', threadId: 't-1' });
  stream.onSession({ mcpToolMap: new Map([['mcp_docs_lookup', { serverName: 'docs', toolName: 'lookup' }]]) });
  stream.onEvent({ type: 'system', subtype: 'init', session_id: null });
  stream.toolObserver.start({ name: 'todo_write', args: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }, call: { id: 't1' } });
  stream.toolObserver.start({ name: 'todo_write', args: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] }, call: { id: 't2' } });
  stream.toolObserver.start({ name: 'mcp_docs_lookup', args: { q: 'x' }, call: { id: 'm1' } });
  stream.toolObserver.result({ name: 'mcp_docs_lookup', result: { text: 'found' }, call: { id: 'm1' } });
  stream.toolObserver.start({ name: 'web_search', args: { query: 'codex sdk' }, call: { id: 'w1' } });
  stream.toolObserver.result({ name: 'web_search', result: { results: [] }, call: { id: 'w1' } });
  stream.toolObserver.start({ name: 'read_file', args: { path: 'x' }, call: { id: 'r1' } });
  stream.toolObserver.result({ name: 'read_file', result: { error: 'missing' }, call: { id: 'r1' } });
  stream.toolObserver.start({ name: 'run_command', args: { command: 'rm', args: ['-rf', 'x'] }, call: { id: 'd1' } });
  stream.toolObserver.result({ name: 'run_command', result: { approved: false, message: 'Command was not approved.' }, call: { id: 'd1' } });
  stream.toolObserver.start({ name: 'run_command', args: { command: 'sleep', args: ['9'] }, call: { id: 'c1' } });
  stream.onEvent({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'stopped', usage: {} });
  stream.onEvent({ type: 'assistant', text: 'ignored after finish' });
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events[0], { type: 'thread.started', thread_id: 't-1' });
  assert.equal(events[2].type, 'item.started');
  assert.deepEqual(events[2].item.items, [{ text: 'a', completed: true }, { text: 'b', completed: false }]);
  assert.equal(events[3].type, 'item.updated');
  assert.equal(events[3].item.id, events[2].item.id);
  const completed = events.filter((event) => event.type === 'item.completed').map((event) => event.item);
  const mcp = completed.find((item) => item.server === 'docs');
  assert.equal(mcp.tool, 'lookup');
  assert.equal(mcp.status, 'completed');
  assert.deepEqual(mcp.result.structured_content, { text: 'found' });
  assert.equal(completed.find((item) => item.type === 'web_search').query, 'codex sdk');
  const read = completed.find((item) => item.tool === 'read_file');
  assert.equal(read.server, 'oasis');
  assert.equal(read.status, 'failed');
  assert.match(read.error.message, /missing/);
  assert.deepEqual(completed.find((item) => item.type === 'todo_list').items.map((item) => item.completed), [true, true]);
  const commands = completed.filter((item) => item.type === 'command_execution');
  assert.deepEqual(commands.map((item) => [item.command, item.status]), [['rm -rf x', 'failed'], ['sleep 9', 'failed']]);
  assert.equal(events.at(-1).type, 'turn.failed');
  assert.match(events.at(-1).error.message, /error_max_turns: stopped/);
  assert.ok(!text.includes('ignored after finish'));
});

test('Codex --config values and reasoning effort map to OASIS', () => {
  assert.equal(parseCodexConfigValue('"never"'), 'never');
  assert.equal(parseCodexConfigValue('true'), true);
  assert.equal(parseCodexConfigValue('3'), 3);
  assert.deepEqual(parseCodexConfigValue('["a","b"]'), ['a', 'b']);
  assert.equal(parseCodexConfigValue('live'), 'live');
  assert.equal(codexEffort('minimal'), 'low');
  assert.equal(codexEffort('xhigh'), 'max');
  assert.equal(codexEffort('bogus'), null);
});

// Files over 1 MiB are not read for diffs; an edit to one was reported as
// "add" (exec JSON) and as an add with no change (app server).
test('an edit to a file over 1 MiB is reported as an update', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-exec-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const big = path.join(root, 'big.sql');
  await writeFile(big, 'x'.repeat(2 * 1024 * 1024));
  // The app server picks add/update from this: missing is null, too large is not.
  assert.equal(readSmall(big), LARGE_FILE);
  assert.equal(readSmall(path.join(root, 'missing.sql')), null);
  assert.equal(readSmall(root), null);
  let text = '';
  const stream = createCodexExecJsonStream({ write: (chunk) => { text += chunk; }, root, threadId: 't-large' });
  stream.toolObserver.start({ name: 'edit_file', args: { path: 'big.sql', old_string: 'x', new_string: 'y' }, call: { id: 'e1' } });
  await writeFile(big, 'y' + 'x'.repeat(2 * 1024 * 1024 - 1));
  stream.toolObserver.result({ name: 'edit_file', result: { path: 'big.sql', changed: true }, call: { id: 'e1' } });
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  const change = events.find((event) => event.type === 'item.completed' && event.item.type === 'file_change');
  assert.deepEqual(change.item.changes, [{ path: big, kind: 'update' }]);
});
