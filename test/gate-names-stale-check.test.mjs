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
  await runAgentTurn(session, 'Fix add and add a negative-number test.', { env, autoApprove: true });
  const gate = requests.flatMap((request) => request.messages).find((message) => message.role === 'user' && /post-edit verification gate/.test(String(message.content)));
  assert.ok(gate, 'the gate should fire');
  assert.match(String(gate.content), /Rerun `node test\.mjs` now: it ran before your latest edit/);
});
