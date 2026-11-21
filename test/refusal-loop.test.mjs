// Regression from a live run with qwen2.5-coder:3b on Ollama (2026-11-21): asked to
// add a function, the model called git_commit eight times with reworded messages.
// Every call was refused for the same reason, and the identical-call loop guard
// never fired because the arguments differed.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

async function fakeProvider(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const payload = JSON.parse(body);
    requests.push(payload);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(handler(payload, requests.length)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, baseURL: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-refusal-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-refusal-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, 'a.mjs'), 'export const x = 1;\n');
  return { root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') } };
}

const call = (n, name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
const say = (text) => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });

test('the same refusal with reworded arguments warns on the second try and stops on the fourth', async (t) => {
  const { root, env } = await workspace(t);
  const provider = await fakeProvider(t, (_payload, n) => n <= 8 ? call(n, 'git_commit', { message: 'Attempt ' + n }) : say('done'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'small-model', apiKey: 'k', maxSteps: 12 }, env });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'Add a function add(a,b) to a.mjs', { autoApprove: true, env, approval: async () => true });
  assert.equal(provider.requests.length, 4, 'the turn stops after the fourth identical refusal');
  assert.match(result.text, /git_commit was refused 4 times/);
  const second = JSON.stringify(provider.requests[2].messages);
  assert.match(second, /refused twice in this request/);
  assert.match(second, /The user asked: \\"Add a function add\(a,b\) to a.mjs\\"/);
  assert.match(second, /edit_file/);
});

test('a native call to the function the task names explains it is code to write', async (t) => {
  const { root, env } = await workspace(t);
  const provider = await fakeProvider(t, (_payload, n) => n === 1 ? call(1, 'add', { a: 1, b: 2 }) : say('ok'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'small-model', apiKey: 'k', maxSteps: 5 }, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'Add a function add(a,b) to a.mjs', { autoApprove: true, env, approval: async () => true });
  const sent = JSON.stringify(provider.requests[1].messages);
  assert.match(sent, /There is no tool named/);
  assert.match(sent, /is a name from the task, not a tool/);
  assert.match(sent, /edit_file/);
  assert.doesNotMatch(sent, /Did you mean[^?]*(add_extension|lsp)/, 'a three-letter name is not "close" to unrelated tools');
});

test('a text-only unknown call is answered with the advertised tools only, not deferred ones', async (t) => {
  const { root, env } = await workspace(t);
  const provider = await fakeProvider(t, (_payload, n) => n === 1 ? say('```json\n{"name": "add", "arguments": {"a": 1, "b": 2}}\n```') : say('ok'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'small-model', apiKey: 'k', maxSteps: 5 }, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'Add a function add(a,b) to a.mjs', { autoApprove: true, env, approval: async () => true });
  const reminder = JSON.stringify(provider.requests[1].messages).match(/add is not a tool[^<]*/);
  assert.ok(reminder, 'the model is told the tool does not exist');
  assert.match(reminder[0], /edit_file/);
  assert.doesNotMatch(reminder[0], /git_commit|git_log/, 'deferred tools are not advertised in the reminder');
});

const calls = (n, list) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: list.map(([name, args], i) => ({ id: 'c' + n + '_' + i, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });

test('after a real change, a refused extra step ends with what changed, not "stuck"', async (t) => {
  const { root, env } = await workspace(t);
  const provider = await fakeProvider(t, (_payload, n) => n === 1 ? call(1, 'write_file', { path: 'b.mjs', content: 'export const b = 2;\n' })
    : n <= 6 ? call(n, 'git_commit', { message: 'Add b ' + n }) : say('done'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'small-model', apiKey: 'k', maxSteps: 12 }, env });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'Create b.mjs exporting b = 2', { autoApprove: true, env, approval: async () => true });
  assert.match(result.text, /^Changed b\.mjs\. I stopped trying git_commit, which was refused 4 times: the user did not ask you to commit in this request\./);
  assert.doesNotMatch(result.text, /stuck/);
});

test('write_file in the same reply as the read_file it depends on is refused, and works one reply later', async (t) => {
  const { root, env } = await workspace(t);
  const { readFile } = await import('node:fs/promises');
  const provider = await fakeProvider(t, (_payload, n) => n === 1
    ? calls(1, [['read_file', { path: 'a.mjs' }], ['write_file', { path: 'a.mjs', content: 'export function add(a, b) { return a + b; }\n' }]])
    : n === 2 ? call(2, 'write_file', { path: 'a.mjs', content: 'export const x = 1;\nexport function add(a, b) { return a + b; }\n' })
      : say('done'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'small-model', apiKey: 'k', maxSteps: 6 }, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'Add a function add(a,b) to a.mjs', { autoApprove: true, env, approval: async () => true });
  const first = JSON.stringify(provider.requests[1].messages);
  assert.match(first, /was read in this same reply, so this change was written before you saw its contents/);
  assert.equal(await readFile(path.join(root, 'a.mjs'), 'utf8'), 'export const x = 1;\nexport function add(a, b) { return a + b; }\n');
});

test('an exact-string edit in the same reply as its read still goes through', async (t) => {
  const { root, env } = await workspace(t);
  const { readFile } = await import('node:fs/promises');
  const provider = await fakeProvider(t, (_payload, n) => n === 1
    ? calls(1, [['read_file', { path: 'a.mjs' }], ['edit_file', { path: 'a.mjs', old_string: 'x = 1', new_string: 'x = 2' }]])
    : say('done'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: provider.baseURL, model: 'small-model', apiKey: 'k', maxSteps: 4 }, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'Set x to 2 in a.mjs', { autoApprove: true, env, approval: async () => true });
  assert.equal(await readFile(path.join(root, 'a.mjs'), 'utf8'), 'export const x = 2;\n');
});
