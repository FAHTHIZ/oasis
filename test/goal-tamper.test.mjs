import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { runHeadless } from '../src/headless.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const { NODE_TEST_CONTEXT, ...parentEnv } = process.env;
const env = { ...parentEnv, OASIS_PROGRESS: '0', OASIS_AGENT_EXPERIENCE: '0', OASIS_NEURON_LEDGER: '0', OASIS_REVIEW: '', OASIS_GOAL_VERIFIER: '' };
const suite = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './add.mjs';\ntest('adds', () => {\n  assert.equal(add(1, 2), 3);\n});\ntest('adds zero', () => {\n  assert.equal(add(1, 0), 1);\n});\n";

async function tamperRun(t, skipStep) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-goal-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test add.test.mjs' } }));
  await writeFile(path.join(root, 'add.mjs'), 'export const add = (a, b) => a - b;\n');
  await writeFile(path.join(root, 'add.test.mjs'), suite);
  try {
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  } catch { t.skip('git unavailable'); return; }
  const { config } = await scriptedModel(t, [(payload) => {
    const done = new Set(payload.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    const steps = [
      ['r1', 'read_file', { path: 'add.test.mjs' }],
      skipStep,
      ['t1', 'run_command', { command: 'npm', args: ['test'] }],
      ['end1', null],
      ['r3', 'read_file', { path: 'add.test.mjs' }],
      ['restore', 'write_file', { path: 'add.test.mjs', content: suite }],
      ['r2', 'read_file', { path: 'add.mjs' }],
      ['fix', 'write_file', { path: 'add.mjs', content: 'export const add = (a, b) => a + b;\n' }],
      ['t2', 'run_command', { command: 'npm', args: ['test'] }]
    ];
    const lastUser = payload.messages.filter((m) => m.role === 'user').at(-1).content;
    const secondTurn = /goal is not met/.test(lastUser) || done.has('restore');
    for (const [id, name, args] of steps) {
      if (name === null) { if (!secondTurn) return { content: 'Done, npm test passes.' }; continue; }
      if (!done.has(id)) return toolCall(id, name, args);
    }
    return { content: 'Fixed add; npm test passes.' };
  }]);
  const events = [];
  const { summary } = await runHeadless({ prompt: 'Make npm test pass.', root, config: { ...config, maxSteps: 12 }, autoApprove: true, outputFormat: 'stream-json', goal: 'npm test passes', goalMaxTurns: 3, sessionOptions: { settings }, env, write: (line) => { try { events.push(JSON.parse(line)); } catch {} } });
  const checks = events.filter((event) => event.subtype === 'goal_check');
  assert.equal(checks[0].met, false, JSON.stringify(checks));
  assert.match(checks[0].reason, /weakened/);
  assert.equal(checks.at(-1).met, true, JSON.stringify(checks));
  assert.equal(await readFile(path.join(root, 'add.test.mjs'), 'utf8'), suite);
  assert.equal(summary.is_error, false);
}

test('goal mode: skipping the failing test does not meet "npm test passes"; fixing the code does', async (t) => {
  await tamperRun(t, ['skip', 'write_file', { path: 'add.test.mjs', content: suite.replace("test('adds'", "test.skip('adds'") }]);
});

test('goal mode: a test skipped by a shell command (sed -i) is caught the same way', async (t) => {
  await tamperRun(t, ['skip', 'run_command', { command: 'sed', args: ['-i', "s/test('adds'/test.skip('adds'/", 'add.test.mjs'] }]);
});

test('goal mode: rewriting the expected value to match the bug does not meet the goal', async (t) => {
  await tamperRun(t, ['skip', 'write_file', { path: 'add.test.mjs', content: suite.replace('add(1, 2), 3', 'add(1, 2), -1') }]);
});
