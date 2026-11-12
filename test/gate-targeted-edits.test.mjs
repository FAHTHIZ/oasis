import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-targeted-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-targeted-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'add.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');
  await writeFile(path.join(root, 'test.mjs'), "import { add } from './add.mjs';\nimport assert from 'node:assert';\nassert.equal(add(2, 3), 5);\n");
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0', OASIS_ASSISTED_VERIFICATION: '0' } };
}

// Seen live (gpt-oss-20b, 12 Nov 2026): edit_file, then a passing npm test,
// and the gate still sent the model back to "review the diff". The extra
// round trip took a minute and produced a second summary of the same work.
test('a targeted edit followed by a passing check finishes without a diff-review round trip', async (t) => {
  const { root, env } = await project(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('e1', 'edit_file', { path: 'add.mjs', old_string: 'return a - b;', new_string: 'return a + b;' }),
    toolCall('r1', 'run_command', { command: 'node', args: ['test.mjs'] }),
    { content: 'Fixed add; node test.mjs passes.' },
    { content: 'unexpected extra request' }
  ]);
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  const gates = [];
  const result = await runAgentTurn(session, 'Fix add.', { env, autoApprove: true, onVerificationGate: (gate) => gates.push(gate) });
  assert.equal(gates.length, 0, JSON.stringify(gates));
  assert.equal(requests.length, 3, 'no fourth model request');
  assert.equal(result.finished, true);
  assert.equal(result.verificationIncomplete, false);
  assert.match(result.text, /Fixed add/);
});

test('a whole-file overwrite still needs a diff review after a passing check', async (t) => {
  const { root, env } = await project(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('f1', 'read_file', { path: 'add.mjs' }),
    toolCall('w1', 'write_file', { path: 'add.mjs', content: 'export function add(a, b) {\n  return a + b;\n}\n' }),
    toolCall('r1', 'run_command', { command: 'node', args: ['test.mjs'] }),
    { content: 'Rewrote add.mjs; node test.mjs passes.' },
    toolCall('d1', 'git_diff', {}),
    { content: 'The diff only changes the operator.' }
  ]);
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  const gates = [];
  await runAgentTurn(session, 'Fix add.', { env, autoApprove: true, onVerificationGate: (gate) => gates.push(gate) });
  assert.equal(gates.length, 1);
  assert.ok(gates[0].steps.some((step) => /review the diff of add\.mjs/.test(step)), JSON.stringify(gates[0].steps));
  assert.equal(requests.length, 6);
});
