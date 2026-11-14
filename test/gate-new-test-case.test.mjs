import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// Seen in the live OVH benchmark (taskflow-emoji-truncate, gpt-oss-120b):
// asked to "add a regression test", Oasis added two asserts to an existing
// test() case. The fix was right, but the task's verifier expected a new
// case, and no test reports on the fix by itself.
test('asked for a regression test, asserts added to an existing case get a gate note asking for a separate case', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-new-case-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-new-case-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'src', 'pad.mjs'), "export const pad = (s, n) => s.padStart(n - 1, ' ');\n");
  await writeFile(path.join(root, 'test', 'pad.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { pad } from '../src/pad.mjs';\ntest('keeps long strings', () => {\n  assert.equal(pad('abc', 2), 'abc');\n});\n");
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  } catch { t.skip('git unavailable'); return; }
  const { config, requests } = await scriptedModel(t, [
    toolCall('e1', 'edit_file', { path: 'src/pad.mjs', old_string: 'n - 1', new_string: 'n' }),
    toolCall('e2', 'edit_file', { path: 'test/pad.test.mjs', old_string: "  assert.equal(pad('abc', 2), 'abc');\n", new_string: "  assert.equal(pad('abc', 2), 'abc');\n  assert.equal(pad('a', 3), '  a');\n" }),
    toolCall('r1', 'run_command', { command: 'node', args: ['--test'] }),
    { content: 'Fixed pad and added a regression test; node --test passes.' },
    toolCall('e3', 'edit_file', { path: 'test/pad.test.mjs', old_string: "  assert.equal(pad('a', 3), '  a');\n});\n", new_string: "});\ntest('pads to the full width', () => {\n  assert.equal(pad('a', 3), '  a');\n});\n" }),
    toolCall('r2', 'run_command', { command: 'node', args: ['--test'] }),
    { content: 'Fixed pad; the new test "pads to the full width" passes with node --test.' }
  ]);
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0' };
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'pad() pads one short. Fix it and add a regression test.', { env, autoApprove: true, maxSteps: 20 });
  const gate = requests.flatMap((request) => request.messages).find((message) => message.role === 'user' && /post-edit verification gate/.test(String(message.content)));
  assert.ok(gate, 'the gate should fire');
  assert.match(String(gate.content), /only added assertions inside existing test cases \(test\/pad\.test\.mjs\)/);
  assert.match(result.text, /pads to the full width/);
});
