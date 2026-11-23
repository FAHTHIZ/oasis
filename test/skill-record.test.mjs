// Skill track records (src/skill-record.mjs): tasks that follow a skill are
// credited to its current version by their checked verdict, not by finishing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { deriveTaskSpec } from '../src/task-model.mjs';
import { formatSkillRecordRows, noteSkillUse, readSkillRecords, recordSkillOutcomes, skillRecordNote, skillRecordRows, skillTrackRecord, summarizeRuns, verdictClass } from '../src/skill-record.mjs';

async function tempEnv(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-record-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, env: { ...process.env, OASIS_SKILL_RECORD_FILE: path.join(dir, 'nested', 'skill-record.json'), OASIS_SKILL_RECORD: '' } };
}

const outcome = (verdict, extra = {}) => ({ verdict, execution: 'completed', claims: { issues: [] }, acceptance: { criteria: [] }, ...extra });

test('verdicts are classed by what was checked, not by completion', () => {
  assert.equal(verdictClass('verified'), 'success');
  assert.equal(verdictClass('independently_verified'), 'success');
  assert.equal(verdictClass('rejected'), 'failure');
  assert.equal(verdictClass('incomplete'), 'failure');
  assert.equal(verdictClass('unverified'), 'neutral', 'finishing without checks teaches nothing');
  assert.equal(verdictClass('evidenced'), 'neutral');
  const flagged = summarizeRuns([{ class: 'success', at: 1 }, { class: 'failure', at: 2 }, { class: 'failure', at: 3 }, { class: 'failure', at: 4, reason: 'tests failed' }]);
  assert.equal(flagged.flagged, true);
  assert.equal(flagged.lastFailure.reason, 'tests failed');
  assert.equal(summarizeRuns([{ class: 'success' }, { class: 'failure' }, { class: 'neutral' }]).flagged, false);
});

test('outcomes are credited per skill version, and a re-assessment replaces its entry', async (t) => {
  const { env } = await tempEnv(t);
  const body = '# Release\n1. Run the tests.\n2. Tag.';
  const session = { sessionId: 's1', root: '/tmp/x', task: deriveTaskSpec('Cut the release and make sure the tests pass.') };
  noteSkillUse(session, 'release', body);
  noteSkillUse(session, 'release', body);
  assert.equal(session.taskSkills.length, 1);
  await recordSkillOutcomes(session, outcome('rejected', { claims: { issues: [{ reason: 'the last test command exited with code 1' }] } }), { env });
  await recordSkillOutcomes(session, outcome('verified'), { env });
  let record = skillTrackRecord('release', body, { env });
  assert.equal(record.current.runs, 1, 'the same turn counts once, with its latest verdict');
  assert.equal(record.current.success, 1);
  session.task = { ...session.task, turns: 2 };
  await recordSkillOutcomes(session, outcome('rejected', { claims: { issues: [{ reason: 'the last test command exited with code 1' }] } }), { env });
  record = skillTrackRecord('release', body, { env });
  assert.equal(record.current.decisive, 2);
  assert.match(skillRecordNote(record), /1 of 2 decisive task\(s\) that followed it were verified, 1 rejected or failed\. Last failure: the last test command exited with code 1/);
  const edited = body + '\n3. Push the tag.';
  const changed = skillTrackRecord('release', edited, { env });
  assert.equal(changed.current, null);
  assert.match(skillRecordNote(changed), /changed since it was last used.*1 of 2/);
  const mode = (await stat(env.OASIS_SKILL_RECORD_FILE)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.match(formatSkillRecordRows(skillRecordRows({ env })), /release: 2 task\(s\), 50% verified of 2 decisive, 1 failed/);
  const raw = JSON.stringify(readSkillRecords(env));
  assert.doesNotMatch(raw, /\/tmp\/x/, 'the workspace path is not stored');
});

test('a skill used for another task is not credited, and OASIS_SKILL_RECORD=0 turns it off', async (t) => {
  const { env } = await tempEnv(t);
  const session = { sessionId: 's2', task: deriveTaskSpec('Write the changelog entry.') };
  noteSkillUse(session, 'changelog', 'Write it.');
  session.task = deriveTaskSpec('Now fix the parser bug.');
  assert.deepEqual(await recordSkillOutcomes(session, outcome('verified'), { env }), []);
  noteSkillUse(session, 'changelog', 'Write it.');
  assert.deepEqual(await recordSkillOutcomes(session, outcome('verified'), { env: { ...env, OASIS_SKILL_RECORD: '0' } }), []);
  assert.equal(skillTrackRecord('changelog', 'Write it.', { env }), null);
});

test('flagged skills tell the model to check the steps instead of trusting them', async (t) => {
  const { env } = await tempEnv(t);
  const session = { sessionId: 's3', task: deriveTaskSpec('Deploy the service and make sure the health check passes.') };
  noteSkillUse(session, 'deploy', 'Run deploy.sh');
  for (let turn = 1; turn <= 3; turn += 1) {
    session.task = { ...session.task, turns: turn };
    await recordSkillOutcomes(session, outcome('rejected'), { env });
  }
  assert.match(skillRecordNote(skillTrackRecord('deploy', 'Run deploy.sh', { env })), /fail more often than not: check each step/);
});

test('a turn that loads a skill records its checked outcome, and the next load shows it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, '.config-oasis');
  await mkdir(path.join(root, '.oasis', 'skills', 'sum-fix'), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(root, '.oasis', 'skills', 'sum-fix', 'SKILL.md'), '---\nname: sum-fix\ndescription: Fix arithmetic helpers\n---\nRead the helper, fix the operator, run its test.\n');
  await writeFile(path.join(root, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(path.join(root, 'sum.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
  const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const script = [
    call('a0', 'load_skill', { name: 'sum-fix' }),
    call('a1', 'read_file', { path: 'sum.mjs' }),
    call('a2', 'write_file', { path: 'sum.mjs', content: 'export const sum = (a, b) => a + b;\n' }),
    call('a3', 'run_command', { command: 'node', args: ['--test', 'sum.test.mjs'] }),
    { role: 'assistant', content: 'Fixed sum.mjs; node --test sum.test.mjs passes.' }
  ];
  const second = [call('b0', 'load_skill', { name: 'sum-fix' }), { role: 'assistant', content: 'Loaded.' }];
  let step = 0;
  let step2 = 0;
  let secondLoad = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    const b0 = payload.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'b0');
    if (b0) secondLoad = JSON.parse(b0.content);
    res.writeHead(200, { 'content-type': 'application/json' });
    const secondTurn = payload.messages.some((m) => m.role === 'user' && /again for the next helper/.test(String(m.content)));
    const message = secondTurn ? second[Math.min(step2++, second.length - 1)] : script[Math.min(step++, script.length - 1)];
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SKILL_RECORD_FILE: path.join(configDir, 'skill-record.json'), OASIS_SKILL_RECORD: '' };
  delete env.NODE_TEST_CONTEXT;
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8 } });
  await runAgentTurn(session, 'Use the sum-fix skill to fix sum.mjs and make sure the test passes.', { autoApprove: true, env });
  assert.equal(session.task.outcome.verdict, 'verified');
  const rows = skillRecordRows({ env });
  assert.equal(rows[0].name, 'sum-fix');
  assert.equal(rows[0].success, 1);
  await runAgentTurn(session, 'Load the sum-fix skill again for the next helper.', { autoApprove: true, env });
  assert.ok(secondLoad, 'the second load returned');
  assert.match(secondLoad.trackRecord, /1 of 1 decisive task\(s\) that followed it were verified/);
});
