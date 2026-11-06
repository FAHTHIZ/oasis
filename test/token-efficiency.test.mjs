import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, modelFacingResult } from '../src/agent.mjs';
import { executeTool } from '../src/tools.mjs';

// A scripted provider through fetchImpl: no server, no network.
function scripted(steps) {
  const payloads = [];
  const fetchImpl = async (url, init) => {
    payloads.push(JSON.parse(String(init.body)));
    const step = steps[Math.min(payloads.length - 1, steps.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: step }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, payloads };
}

const callTool = (id, name, args = {}) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function gitRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-tokens-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  git('init', '-q');
  await writeFile(path.join(root, 'a.txt'), Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n') + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  await writeFile(path.join(root, 'a.txt'), Array.from({ length: 40 }, (_, i) => i === 20 ? 'changed' : 'line ' + i).join('\n') + '\n');
  return root;
}

test('git_diff reaches the model as stdout once, without the command line or a duplicate output copy', async (t) => {
  const root = await gitRepo(t);
  const raw = await executeTool('git_diff', {}, { root });
  // The runtime result keeps its full shape for in-process consumers.
  assert.equal(typeof raw.output, 'string');
  assert.match(raw.command, /:\(exclude\)/);
  const lean = modelFacingResult('git_diff', raw);
  assert.equal(lean.stdout, raw.stdout);
  assert.equal(lean.exitCode, 0);
  assert.equal('output' in lean, false);
  assert.equal('command' in lean, false);
  assert.equal('timedOut' in lean, false);
  assert.ok(JSON.stringify(lean).length < JSON.stringify(raw).length * 0.6, 'the model-facing diff is close to the size of the diff itself');

  const model = scripted([callTool('d1', 'git_diff'), { role: 'assistant', content: 'done' }]);
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'https://bench.invalid/v1', model: 'fixture', apiKey: 'k', maxSteps: 4 } });
  const result = await runAgentTurn(session, 'Show the diff.', { autoApprove: true, fetchImpl: model.fetchImpl });
  assert.equal(result.finished, true);
  const sent = model.payloads[1].messages.find((m) => m.role === 'tool');
  const parsed = JSON.parse(sent.content);
  assert.match(parsed.stdout, /\+changed/);
  assert.equal(parsed.output, undefined);
  assert.equal(parsed.command, undefined);
  assert.equal(sent.content.split('+changed').length - 1, 1, 'the diff text is sent once');
});

test('a failed git call still tells the model which command failed', () => {
  const lean = modelFacingResult('git_diff', { command: 'git diff --no-color -- :(exclude).env :(exclude)**/.env', exitCode: 128, signal: null, timedOut: false, stdout: '', stderr: 'fatal: bad revision', output: '\nfatal: bad revision', truncated: false });
  assert.equal(lean.exitCode, 128);
  assert.equal(lean.stderr, 'fatal: bad revision');
  assert.equal(lean.command, 'git diff --no-color -- (secret paths excluded)');
  assert.equal(lean.output, undefined);
  // Other tools and hook-replaced results pass through untouched.
  const other = { command: 'git status', stdout: 'x', output: 'x' };
  assert.equal(modelFacingResult('run_command', other), other);
  const hooked = { output: 'replaced by a hook' };
  assert.equal(modelFacingResult('git_diff', hooked), hooked);
});

import { supersedeHistory } from '../src/superseded-results.mjs';
import { compactHistoryIfNeeded } from '../src/agent.mjs';

function history(root) {
  const big = Array.from({ length: 120 }, (_, i) => 'const value' + i + ' = ' + i + ';').join('\n');
  const assistant = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const tool = (id, name, value, tail = '') => ({ role: 'tool', tool_call_id: id, name, content: JSON.stringify(value) + tail });
  return [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'task' },
    assistant('r1', 'read_file', { path: 'a.mjs' }), tool('r1', 'read_file', { path: 'a.mjs', content: big }, '\n\n<system-reminder>keep me</system-reminder>'),
    assistant('r2', 'read_file', { path: 'a.mjs', offset: 10, limit: 20 }), tool('r2', 'read_file', { path: 'a.mjs', content: big.slice(0, 600), startLine: 10, endLine: 29, totalLines: 120, truncated: true }),
    assistant('b1', 'read_file', { path: 'b.mjs' }), tool('b1', 'read_file', { path: 'b.mjs', content: big }),
    assistant('t1', 'run_command', { command: 'npm', args: ['test'] }), tool('t1', 'run_command', { command: 'npm', exitCode: 1, stdout: 'x'.repeat(2000) + 'FAIL: expected 2 got 3', stderr: '' }),
    assistant('t2', 'run_command', { command: 'npm', args: ['test'] }), tool('t2', 'run_command', { command: 'npm', exitCode: 0, stdout: 'y'.repeat(800) + 'all passed', stderr: '' }),
    // A ranged re-read of b.mjs covers only part of the earlier full read.
    assistant('b2', 'read_file', { path: 'b.mjs', offset: 1, limit: 10 }), tool('b2', 'read_file', { path: 'b.mjs', content: big.slice(0, 500), startLine: 1, endLine: 10, totalLines: 120, truncated: true }),
    // An unchanged pointer is not a new copy.
    assistant('b3', 'read_file', { path: 'b.mjs' }), tool('b3', 'read_file', { path: 'b.mjs', unchanged: true, message: 'File unchanged since your earlier read_file' }),
    assistant('r3', 'read_file', { path: 'a.mjs' }), tool('r3', 'read_file', { path: 'a.mjs', content: big + '\nedited' })
  ];
}

test('superseded results: older reads covered by a newer read and earlier runs of the same command become stubs', () => {
  const root = os.tmpdir();
  const input = history(root);
  const snapshot = JSON.stringify(input);
  const { messages, replaced, saved } = supersedeHistory(input, { root, env: {} });
  assert.equal(JSON.stringify(input), snapshot, 'input is not mutated');
  const byId = (id) => messages.find((m) => m.role === 'tool' && m.tool_call_id === id).content;
  assert.match(byId('r1'), /"superseded":true/);
  assert.match(byId('r1'), /<system-reminder>keep me<\/system-reminder>$/);
  assert.match(byId('r2'), /"superseded":true/, 'a ranged read inside a newer complete read is covered');
  assert.doesNotMatch(byId('r3'), /superseded/, 'the newest read stays');
  assert.doesNotMatch(byId('b1'), /superseded/, 'a partial re-read does not cover a complete read');
  assert.match(byId('t1'), /"superseded":true/);
  assert.match(byId('t1'), /FAIL: expected 2 got 3/, 'the stub keeps the end of the old output');
  assert.doesNotMatch(byId('t2'), /superseded/);
  assert.equal(replaced, 3);
  assert.ok(saved > 4000);
  assert.equal(supersedeHistory(input, { root, env: { OASIS_SUPERSEDE_RESULTS: '0' } }).replaced, 0);
  assert.equal(supersedeHistory(input, { root, env: {}, config: { supersedeResults: false } }).replaced, 0);
});

test('when superseded results alone bring history under the threshold, no summary request is made', async () => {
  const root = os.tmpdir();
  const messages = history(root);
  let requests = 0;
  const session = { root, config: { protocol: 'openai-compatible', baseURL: 'https://bench.invalid/v1', model: 'fixture', apiKey: 'k' }, messages };
  const size = (list) => list.reduce((n, m) => n + String(m.content || '').length + JSON.stringify(m.tool_calls || '').length, 0);
  const before = size(messages);
  const result = await compactHistoryIfNeeded(session, { thresholdChars: Math.max(10_000, before - 3000), env: {}, fetchImpl: async () => { requests++; throw new Error('no summary expected'); } });
  assert.equal(result.compacted, false);
  assert.equal(requests, 0);
  assert.ok(size(session.messages) < before - 4000);
  assert.ok(session.supersededResultChars > 4000);
});
