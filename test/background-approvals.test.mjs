import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { requestBackgroundApproval, answerBackgroundApproval, pendingApproval, listBackgroundSessions, describeEntry, summarizeActivity, backgroundDirectory, currentBootId } from '../src/background-sessions.mjs';
import { runHeadless } from '../src/headless.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

async function fixture(t, id = 'bg-appr0001') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-approve-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const dir = backgroundDirectory(env);
  await mkdir(dir, { recursive: true });
  const entry = { id, runId: 'r1', sessionId: 's1', root: home, prompt: 'task', status: 'running', startedAt: new Date().toISOString(), bootId: currentBootId(), logFile: path.join(dir, id + '.log'), pid: process.pid };
  await writeFile(path.join(dir, id + '.json'), JSON.stringify(entry));
  return { env, id, home };
}

async function waitForPending(id, env) {
  for (let i = 0; i < 200; i++) {
    const pending = await pendingApproval(id, env);
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no pending approval appeared');
}

test('a background approval waits for oasis bg approve and shows as needs-input', async (t) => {
  const { env, id } = await fixture(t);
  const asked = requestBackgroundApproval(id, { tool: 'run_command', message: 'Run git push?', canAlways: true }, env, { pollMs: 10 });
  const pending = await waitForPending(id, env);
  assert.equal(pending.tool, 'run_command');
  const [listed] = await listBackgroundSessions(env);
  assert.equal(listed.pendingApproval.requestId, pending.requestId);
  assert.match(describeEntry(listed), /needs-input[\s\S]*waiting for approval: Run git push\?/);
  await answerBackgroundApproval(id, 'allow', env, { always: true });
  assert.equal(await asked, 'always');
  assert.equal(await pendingApproval(id, env), null);
  await assert.rejects(answerBackgroundApproval(id, 'allow', env), /no pending approval/);
});

test('deny, timeout, and stale answers never approve a later request', async (t) => {
  const { env, id } = await fixture(t);
  const first = requestBackgroundApproval(id, { tool: 'edit_file', message: 'Edit a.txt?' }, env, { pollMs: 10 });
  await waitForPending(id, env);
  await answerBackgroundApproval(id, 'deny', env);
  assert.equal(await first, 'deny');
  // A decision left over from an earlier request id is ignored.
  await writeFile(path.join(backgroundDirectory(env), id + '.decision.json'), JSON.stringify({ requestId: 'old', behavior: 'allow' }));
  assert.equal(await requestBackgroundApproval(id, { tool: 'edit_file', message: 'again' }, env, { pollMs: 10, timeoutMs: 120 }), 'timeout');
  assert.equal(await pendingApproval(id, env), null);
  // always is ignored when the request had no rule to remember.
  const third = requestBackgroundApproval(id, { tool: 'x', message: 'y' }, env, { pollMs: 10 });
  await waitForPending(id, env);
  await answerBackgroundApproval(id, 'allow', env, { always: true });
  assert.equal(await third, 'allow');
});

test('parallel requests from one run are asked one at a time', async (t) => {
  const { env, id } = await fixture(t);
  const a = requestBackgroundApproval(id, { message: 'A' }, env, { pollMs: 10 });
  const b = requestBackgroundApproval(id, { message: 'B' }, env, { pollMs: 10 });
  assert.equal((await waitForPending(id, env)).message, 'A');
  await answerBackgroundApproval(id, 'allow', env);
  assert.equal(await a, 'allow');
  let next = await waitForPending(id, env);
  for (let i = 0; next.message !== 'B' && i < 50; i++) { await new Promise((resolve) => setTimeout(resolve, 20)); next = await waitForPending(id, env); }
  assert.equal(next.message, 'B');
  await answerBackgroundApproval(id, 'deny', env);
  assert.equal(await b, 'deny');
});

test('activity summary reports a waiting approval', () => {
  const log = [JSON.stringify({ type: 'tool_use', name: 'run_command', input: { command: 'git' } }), JSON.stringify({ type: 'system', subtype: 'permission_request', tool: 'run_command', message: 'Run git push origin main?' })].join('\n');
  assert.match(summarizeActivity(log), /^needs approval: Run git push origin main\?/);
});

for (const behavior of ['allow', 'deny']) {
  test('a headless background run relays its approval and ' + (behavior === 'allow' ? 'runs' : 'skips') + ' the command', async (t) => {
    const { env, id, home } = await fixture(t, behavior === 'allow' ? 'bg-relayallow' : 'bg-relaydeny');
    const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'git', args: ['--version'] }), { content: 'finished' }]);
    let out = '';
    const runEnv = { ...env, OASIS_BACKGROUND_ID: id, OASIS_BACKGROUND_RUN_ID: 'r1' };
    const run = runHeadless({ prompt: 'check git', root: home, config, env: runEnv, outputFormat: 'stream-json', sessionOptions: { settings }, write: (text) => { out += text; } });
    await waitForPending(id, env);
    await answerBackgroundApproval(id, behavior, env);
    const { summary } = await run;
    const events = out.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.subtype === 'permission_request' && event.tool === 'run_command'));
    const decision = events.find((event) => event.subtype === 'permission' && event.via === 'background');
    assert.equal(decision.allowed, behavior === 'allow');
    const result = events.find((event) => event.type === 'tool_result' && event.name === 'run_command');
    if (behavior === 'allow') {
      assert.equal(result.is_error, false, JSON.stringify(result));
      assert.equal((summary.permission_denials || []).length, 0);
    } else {
      assert.equal(summary.permission_denials.length, 1);
      assert.match(summary.permission_denials[0].detail, /oasis bg deny/);
    }
  });
}

test('oasis bg list and bg approve answer a waiting run from the command line', async (t) => {

  const { fileURLToPath } = await import('node:url');
  const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
  const { env, id } = await fixture(t, 'bg-cliappr1');
  const asked = requestBackgroundApproval(id, { tool: 'run_command', message: 'Run npm publish?' }, env, { pollMs: 10 });
  await waitForPending(id, env);
  const { spawn } = await import('node:child_process');
  const runCli = (args) => new Promise((resolve) => { const child = spawn(process.execPath, [CLI, ...args], { env }); let stdout = ''; child.stdout.on('data', (d) => { stdout += d; }); child.on('close', (code) => resolve({ code, stdout })); });
  const listed = await runCli(['bg', 'list']);
  assert.match(listed.stdout, /waiting for your approval/);
  assert.match(listed.stdout, /needs-input/);
  const approved = await runCli(['bg', 'approve', id]);
  assert.equal(approved.code, 0, approved.stdout);
  assert.match(approved.stdout, /Approved: Run npm publish\?/);
  assert.equal(await asked, 'allow');
});

test('startup notice lists runs that wait for approval or died unfinished', async () => {
  const { backgroundStartupNotice } = await import('../src/background-sessions.mjs');
  assert.equal(backgroundStartupNotice([{ id: 'bg-a', status: 'completed', root: '/w' }], '/w'), '');
  const notice = backgroundStartupNotice([
    { id: 'bg-a', status: 'running', root: '/w', pendingApproval: { requestId: 'x' } },
    { id: 'bg-b', status: 'interrupted', root: '/other/proj', name: 'refactor' },
    { id: 'bg-c', status: 'interrupted', kind: 'exec', root: '/w' }
  ], '/w');
  assert.match(notice, /1 run\(s\) waiting for your approval: bg-a\./);
  assert.match(notice, /1 run\(s\) stopped without finishing.*bg-b \(refactor\) in proj/);
  assert.doesNotMatch(notice, /bg-c/);
});
