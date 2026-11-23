import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, appendFile, utimes, mkdir, readdir } from 'node:fs/promises';
import {
  actionLine, applyReconciliation, checkProbes, compactJournal, idempotencyKey, journalDone, journalIntent,
  journalPathFor, probesFor, pruneJournals, readJournal, reconcileJournal, reconciliationNote
} from '../src/intent-journal.mjs';
import { INTERRUPTED_TOOL_RESULT, loadSession, saveSession } from '../src/sessions.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: path.join(root, '.cfg') } };
}

test('a write that happened is reported applied, one that did not is not_applied', async (t) => {
  const { root, env } = await workspace(t);
  await writeFile(path.join(root, 'a.txt'), 'old\n');
  const session = { root, settings: {} };
  const intent = await journalIntent(session, { tool: 'write_file', args: { path: 'a.txt', content: 'new\n' }, callId: 'c1', env });
  assert.equal(intent.probes[0].kind, 'file');
  assert.equal((await checkProbes(root, intent.probes)).state, 'not_applied');
  await writeFile(path.join(root, 'a.txt'), 'new\n');
  assert.equal((await checkProbes(root, intent.probes)).state, 'applied');
  await writeFile(path.join(root, 'a.txt'), 'something else\n');
  assert.equal((await checkProbes(root, intent.probes)).state, 'changed');
});

test('the journal is append-only, fsynced JSONL and survives a torn last line', async (t) => {
  const { root, env } = await workspace(t);
  const session = { root, settings: {} };
  const one = await journalIntent(session, { tool: 'delete_file', args: { path: 'gone.txt' }, callId: 'd1', env });
  await journalDone(session, one, { deleted: true });
  await appendFile(session.journalPath, '{"v":1,"t":"intent","seq":3,"cal');
  const records = await readJournal(session.journalPath);
  assert.deepEqual(records.map((record) => record.t), ['intent', 'done']);
  assert.equal(records[1].status, 'ok');
  assert.equal(path.dirname(session.journalPath), path.dirname(journalPathFor(root, session.journalId, env)));
  assert.ok(!JSON.stringify(records).includes('gone.txt') || records[0].summary === 'gone.txt', 'only a short summary is kept');
});

test('in-doubt and unrecorded calls are found and decided from the world', async (t) => {
  const { root, env } = await workspace(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one'], { cwd: root });
  const session = { root, settings: {} };
  // 1. a command that wrote its file, then OASIS died before it returned
  await journalIntent(session, { tool: 'run_shell', args: { command: 'echo hi > out.txt' }, callId: 's1', env });
  await writeFile(path.join(root, 'out.txt'), 'hi\n');
  // 2. a commit that finished, but the transcript only has the placeholder
  const commit = await journalIntent(session, { tool: 'run_shell', args: { command: 'git commit -am two' }, callId: 's2', env });
  await writeFile(path.join(root, 'a.txt'), 'b\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'two'], { cwd: root });
  await journalDone(session, commit, { exitCode: 0, stdout: '' });
  // 3. an edit that never ran
  await journalIntent(session, { tool: 'write_file', args: { path: 'never.txt', content: 'x' }, callId: 'w1', env });
  // 4. a finished call whose result is in the transcript: not reported
  const fine = await journalIntent(session, { tool: 'run_shell', args: { command: 'touch ok.txt' }, callId: 's3', env });
  await journalDone(session, fine, { exitCode: 0 });
  // 5. an API call with nothing to probe
  await journalIntent(session, { tool: 'mcp__stripe__create_refund', args: { amount: 5 }, callId: 'm1', env });

  const messages = [
    { role: 'assistant', content: null, tool_calls: ['s1', 's2', 'w1', 's3', 'm1'].map((id) => ({ id, type: 'function', function: { name: 'run_shell', arguments: '{}' } })) },
    { role: 'tool', tool_call_id: 's1', content: INTERRUPTED_TOOL_RESULT },
    { role: 'tool', tool_call_id: 's2', content: INTERRUPTED_TOOL_RESULT },
    { role: 'tool', tool_call_id: 'w1', content: INTERRUPTED_TOOL_RESULT },
    { role: 'tool', tool_call_id: 's3', content: '{"exitCode":0}' },
    { role: 'tool', tool_call_id: 'm1', content: INTERRUPTED_TOOL_RESULT }
  ];
  const reconciliation = await reconcileJournal(root, session.journalPath, messages);
  const byCall = Object.fromEntries(reconciliation.actions.map((action) => [action.call, action]));
  assert.deepEqual(Object.keys(byCall).sort(), ['m1', 's1', 's2', 'w1']);
  assert.equal(byCall.s1.kind, 'in_doubt');
  assert.equal(byCall.s1.state, 'changed');
  assert.equal(byCall.s2.kind, 'unrecorded');
  assert.equal(byCall.s2.state, 'changed');
  assert.match(byCall.s2.findings.join(' '), /HEAD moved/);
  assert.equal(byCall.w1.state, 'not_applied');
  assert.equal(byCall.m1.state, 'unknown');
  assert.match(actionLine(byCall.m1), /cannot tell/);

  const replaced = applyReconciliation(messages, reconciliation);
  assert.equal(replaced, 4);
  assert.match(messages[3].content, /did not take effect/);
  const note = reconciliationNote(reconciliation);
  assert.match(note, /<in-doubt-actions>/);
  assert.match(note, /Do not repeat an action that took effect/);
});

test('the idempotency key ignores argument order', () => {
  assert.equal(idempotencyKey('run_shell', { command: 'x', cwd: 'a' }), idempotencyKey('run_shell', { cwd: 'a', command: 'x' }));
  assert.notEqual(idempotencyKey('run_shell', { command: 'x' }), idempotencyKey('run_shell', { command: 'y' }));
});

test('command probes hash the paths the command line names', async (t) => {
  const { root } = await workspace(t);
  await writeFile(path.join(root, 'x.js'), '1');
  const probes = await probesFor(root, 'run_shell', { command: "sed -i 's/1/2/' x.js" });
  assert.equal(probes[0].kind, 'paths');
  assert.deepEqual(probes[0].files.map((file) => file.path), ['x.js']);
  assert.ok(/^[0-9a-f]{64}$/.test(probes[0].files[0].before));
  const outside = await probesFor(root, 'write_file', { path: '../../etc/passwd', content: 'x' });
  assert.deepEqual(outside, [], 'paths outside the workspace are never probed');
});

test('compaction keeps unresolved intents, and old journals are pruned', async (t) => {
  const { root, env } = await workspace(t);
  const session = { root, settings: {} };
  const first = await journalIntent(session, { tool: 'run_shell', args: { command: 'deploy' }, callId: 'keep', env });
  for (let i = 0; i < 450; i++) {
    const intent = await journalIntent(session, { tool: 'run_shell', args: { command: 'echo ' + i }, callId: 'c' + i, env });
    await journalDone(session, intent, { exitCode: 0 });
  }
  await compactJournal(session.journalPath);
  const records = await readJournal(session.journalPath);
  assert.ok(records.length <= 401);
  assert.ok(records.some((record) => record.call === first.call && record.t === 'intent'));
  const dir = path.dirname(session.journalPath);
  const old = path.join(dir, 'old-journal-0001.jsonl');
  await writeFile(old, '');
  const past = new Date(Date.now() - 30 * 86_400_000);
  await utimes(old, past, past);
  assert.equal(await pruneJournals(dir), 1);
  assert.ok(!(await readdir(dir)).includes('old-journal-0001.jsonl'));
});

test('OASIS_INTENT_JOURNAL=0 writes nothing', async (t) => {
  const { root, env } = await workspace(t);
  const session = { root, settings: {} };
  assert.equal(await journalIntent(session, { tool: 'write_file', args: { path: 'a', content: 'b' }, callId: 'x', env: { ...env, OASIS_INTENT_JOURNAL: '0' } }), null);
  assert.equal(session.journalPath, undefined);
});

test('a resumed session tells the model what happened to calls in flight', async (t) => {
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const { root, env } = await workspace(t);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/app.js'), 'v1\n');
  // The live session: it journaled a write, the write happened, then it died
  // before the result was saved (the saved transcript has the placeholder).
  const live = { root, settings: {}, config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'bump' }] };
  await journalIntent(live, { tool: 'write_file', args: { path: 'src/app.js', content: 'v2\n' }, callId: 'w9', env });
  await writeFile(path.join(root, 'src/app.js'), 'v2\n');
  live.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'w9', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/app.js', content: 'v2\n' }) } }] });
  const saved = await saveSession(live, { env, turnInProgress: true });
  const restored = await loadSession(root, saved.id, { env });
  assert.equal(restored.journalId, live.journalId);

  const { config, requests } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, restore: restored, env });
  t.after(() => closeSession(session));
  const tool = session.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'w9');
  assert.match(tool.content, /checked after restart: write_file \(src\/app\.js\).*took effect/);
  await runAgentTurn(session, 'continue', { env });
  const user = requests[0].messages.filter((message) => message.role === 'user').at(-1).content;
  assert.match(user, /<in-doubt-actions>[\s\S]*write_file \(src\/app\.js\) was started but OASIS stopped before it returned; checked now: it took effect/);
  assert.equal(await readFile(path.join(root, 'src/app.js'), 'utf8'), 'v2\n');
});
