import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-newtest-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-newtest-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
  await writeFile(path.join(root, 'add.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');
  await writeFile(path.join(root, 'test', 'add.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../add.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0', OASIS_ASSISTED_VERIFICATION: '0' } };
}

const PROMPT = 'add() subtracts. Fix it and add a regression test that fails before your fix.';

// Seen in the live head-to-head (taskflow-priority-sort, nemotron-3-ultra):
// after the gate said no test was added, the model answered that an existing
// test "already serves as the regression test" and the run ended unfinished.
test('a model that argues an existing test is enough is asked once more to add one', async (t) => {
  const { root, env } = await project(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('e1', 'edit_file', { path: 'add.mjs', old_string: 'return a - b;', new_string: 'return a + b;' }),
    toolCall('r1', 'run_command', { command: 'npm', args: ['test'] }),
    { content: 'Fixed add. All tests pass.' },
    { content: 'The existing test in test/add.test.mjs already serves as the regression test.' },
    toolCall('e2', 'edit_file', { path: 'test/add.test.mjs', old_string: "test('add', () => assert.equal(add(2, 3), 5));\n", new_string: "test('add', () => assert.equal(add(2, 3), 5));\ntest('add keeps negatives', () => assert.equal(add(-2, -3), -5));\n" }),
    toolCall('r2', 'run_command', { command: 'npm', args: ['test'] }),
    { content: 'Added a regression test; npm test passes.' },
    { content: 'unexpected extra request' }
  ]);
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  const nudges = [];
  const result = await runAgentTurn(session, PROMPT, { env, autoApprove: true, onActionNudge: (n) => nudges.push(n.kind) });
  assert.ok(nudges.includes('new-test'), JSON.stringify(nudges));
  const followup = requests.find((request) => /explicitly asked you to add a new test/.test(JSON.stringify(request.messages.at(-1))));
  assert.ok(followup, 'the follow-up reminder was sent');
  assert.equal(result.verificationIncomplete, false, JSON.stringify(result.verificationIssues));
  assert.match(result.text, /Added a regression test/);
});

test('the new-test follow-up is sent only once; a second refusal is reported as unverified', async (t) => {
  const { root, env } = await project(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('e1', 'edit_file', { path: 'add.mjs', old_string: 'return a - b;', new_string: 'return a + b;' }),
    toolCall('r1', 'run_command', { command: 'npm', args: ['test'] }),
    { content: 'Fixed add. All tests pass.' },
    { content: 'The existing test already covers it.' },
    { content: 'I still think the existing test is enough.' },
    { content: 'unexpected extra request' }
  ]);
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, PROMPT, { env, autoApprove: true });
  assert.equal(requests.length, 5, 'gate note, one follow-up, then stop');
  assert.equal(result.verificationIncomplete, true);
  assert.ok(result.verificationIssues.some((issue) => /asked for new tests/.test(issue)));
});
