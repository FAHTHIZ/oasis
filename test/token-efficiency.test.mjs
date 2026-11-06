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
