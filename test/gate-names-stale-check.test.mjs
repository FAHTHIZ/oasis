import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// Seen live (gpt-oss-20b): the model ran the test, edited test.mjs, then said
// "Ran the tests; output confirms pass". A vague "run a relevant check" took
// two rounds; naming the stale command gets it rerun at once.
test('the verification gate names the check that went stale after a later edit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-stale-check-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-stale-check-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'add.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');
  await writeFile(path.join(root, 'test.mjs'), "import { add } from './add.mjs';\nimport assert from 'node:assert';\nassert.equal(add(2, 3), 5);\n");
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  } catch { t.skip('git unavailable'); return; }
  const { config, requests } = await scriptedModel(t, [
    toolCall('e1', 'edit_file', { path: 'add.mjs', old_string: 'return a - b;', new_string: 'return a + b;' }),
    toolCall('r1', 'run_command', { command: 'node', args: ['test.mjs'] }),
    toolCall('e2', 'edit_file', { path: 'test.mjs', old_string: 'assert.equal(add(2, 3), 5);', new_string: 'assert.equal(add(2, 3), 5);\nassert.equal(add(-2, -3), -5);' }),
    { content: 'Fixed add and added a test. Ran the tests; all tests pass.' },
    toolCall('r2', 'run_command', { command: 'node', args: ['test.mjs'] }),
    toolCall('d1', 'git_diff', {}),
    { content: 'Fixed add; node test.mjs passes.' }
  ]);
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0' };
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  const gates = [];
  await runAgentTurn(session, 'Fix add and add a negative-number test.', { env, autoApprove: true, onVerificationGate: (gate) => gates.push(gate) });
  const gate = requests.flatMap((request) => request.messages).find((message) => message.role === 'user' && /post-edit verification gate/.test(String(message.content)));
  assert.ok(gate, 'the gate should fire');
  assert.match(String(gate.content), /Rerun `node test\.mjs` now: it ran before your latest edit/);
  // Seen live: after the checks the model wrote a second, longer summary of the same work.
  assert.match(String(gate.content), /already saw your previous summary\. After the checks, do not repeat it/);
  // The terminal shows why work continues after a streamed reply.
  assert.equal(gates.length, 1);
  assert.ok(gates[0].steps.includes('rerun node test.mjs'), JSON.stringify(gates[0].steps));
});

// Seen live (gpt-oss-20b through OmniRoute, `oasis -p`): after the gate the
// model reviewed one of two diffs, replied "Check util diff." and the turn
// ended there, so that fragment was the whole printed answer.
test('after the gate, a bare "Check util diff." reply gets one more nudge, and print mode asks for a standalone answer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-gate-followup-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-gate-followup-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'slug.mjs'), "export const slug = (s) => s.replace(' ', '-');\n");
  await writeFile(path.join(root, 'util.mjs'), 'export const sum = (a) => a.reduce((x, y) => x + y, 1);\n');
  await writeFile(path.join(root, 'test.mjs'), "import { sum } from './util.mjs';\nimport assert from 'node:assert';\nassert.equal(sum([1, 2]), 3);\n");
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  } catch { t.skip('git unavailable'); return; }
  const { config, requests } = await scriptedModel(t, [
    toolCall('o1', 'read_file', { path: 'slug.mjs' }),
    toolCall('o2', 'read_file', { path: 'util.mjs' }),
    toolCall('e1', 'write_file', { path: 'slug.mjs', content: "export const slug = (s) => s.replace(/ +/g, '-');\n" }),
    toolCall('e2', 'write_file', { path: 'util.mjs', content: 'export const sum = (a) => a.reduce((x, y) => x + y, 0);\n' }),
    toolCall('r1', 'run_command', { command: 'node', args: ['test.mjs'] }),
    { content: 'Fixed slug and sum; node test.mjs passes.' },
    toolCall('d1', 'git_diff', { path: 'slug.mjs' }),
    { content: 'Check util diff.' },
    toolCall('d2', 'git_diff', { path: 'util.mjs' }),
    { content: 'Fixed slug (all spaces become dashes) and sum (starts at 0); reviewed both diffs and node test.mjs passes.' }
  ]);
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0' };
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'Fix both bugs.', { env, autoApprove: true, textShown: false, maxSteps: 20 });
  assert.match(result.text, /reviewed both diffs/);
  const users = requests.flatMap((request) => request.messages).filter((message) => message.role === 'user').map((message) => String(message.content));
  const gate = users.find((content) => /post-edit verification gate/.test(content));
  assert.ok(gate, 'the gate should fire');
  assert.doesNotMatch(gate, /already saw your previous summary/, 'print mode shows only the final reply');
  assert.ok(users.some((content) => /named the next verification step/.test(content) && /util\.mjs/.test(content)), 'the follow-up names what is still outstanding');
});

test('announcesTerseStep: bare next-step imperatives, not advice to the user', async () => {
  const { announcesTerseStep } = await import('../src/turn-guards.mjs');
  for (const reply of ['Check util diff.', 'Run tests.', 'Now check the util diff.', 'Review src/util.mjs']) assert.equal(announcesTerseStep(reply), true, reply);
  for (const reply of ['Run `npm start` to launch it.', 'Run the tests yourself with npm test if you want.', 'Fixed both bugs; tests pass.', 'Check your API key.', '']) assert.equal(announcesTerseStep(reply), false, reply);
});
