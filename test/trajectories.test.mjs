import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { saveSession } from '../src/sessions.mjs';
import { toShareGPTRecord, toOpenAIRecord, exportSessions, parsePromptFile, runBatch } from '../src/trajectories.mjs';

const convo = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'list files, token ghp_' + 'a'.repeat(36) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'a.js\nb.js' },
  { role: 'assistant', content: 'Two files.' }
];

test('sharegpt and openai records keep tool calls and redact secrets', () => {
  const share = toShareGPTRecord({ id: 's1', messages: convo }, [{ type: 'function', function: { name: 'list_files', description: 'd', parameters: {} } }]);
  assert.deepEqual(share.conversations.map((turn) => turn.from), ['system', 'human', 'function_call', 'observation', 'gpt']);
  assert.deepEqual(JSON.parse(share.conversations[2].value), { name: 'list_files', arguments: { path: '.' } });
  assert.ok(!JSON.stringify(share).includes('a'.repeat(36)));
  assert.equal(JSON.parse(share.tools)[0].name, 'list_files');
  const openai = toOpenAIRecord({ id: 's1', messages: convo });
  assert.equal(openai.messages[2].tool_calls[0].function.name, 'list_files');
  assert.equal(openai.messages[3].tool_call_id, 'c1');
});

test('oasis sessions export writes JSONL for saved sessions', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-traj-'));
  const env = { OASIS_CONFIG_DIR: path.join(base, 'cfg') };
  try {
    const saved = await saveSession({ root: base, messages: convo, config: { model: 'm' } }, { env });
    const out = path.join(base, 'out.jsonl');
    assert.equal(await exportSessions(base, ['--all', '--format', 'sharegpt', '--out', out], { env }), 1);
    const line = JSON.parse((await readFile(out, 'utf8')).trim());
    assert.equal(line.id, saved.id);
    assert.equal(line.conversations.at(-1).value, 'Two files.');
    let printed = '';
    await exportSessions(base, [saved.id], { env, stdout: { write: (text) => { printed += text; } } });
    assert.equal(JSON.parse(printed).messages.length, 5);
    await assert.rejects(() => exportSessions(base, [], { env }), /Usage/);
    await assert.rejects(() => exportSessions(base, ['--all', '--format', 'xml'], { env }), /Unknown export format/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('oasis batch runs each prompt in a fresh session and records failures', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-batch-'));
  try {
    await writeFile(path.join(base, 'p.jsonl'), '{"id":"a","prompt":"say hi"}\nplain text prompt\n// comment\n{"id":"boom","prompt":"fail"}\n');
    assert.equal((await parsePromptFile(path.join(base, 'p.jsonl'))).length, 3);
    const agent = {
      createSession: async () => ({ messages: [{ role: 'system', content: 's' }], toolDefinitions: [] }),
      runAgentTurn: async (session, prompt, options) => {
        assert.equal(await options.approval('x'), false);
        if (prompt === 'fail') throw new Error('model down');
        session.messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: 'done: ' + prompt });
        return { text: 'done: ' + prompt, toolCalls: 0 };
      },
      closeSession: () => {}
    };
    let out = '';
    const result = await runBatch(base, ['p.jsonl', '--format', 'sharegpt', '--concurrency', '2'], { agent, config: { configured: true, model: 'm' }, stdout: { write: (t) => { out += t; } }, stderr: { write: () => {} } });
    assert.deepEqual(result, { total: 3, ok: 2, failed: 1 });
    const rows = out.trim().split('\n').map((line) => JSON.parse(line));
    const a = rows.find((row) => row.id === 'a');
    assert.equal(a.trajectory.conversations.at(-1).value, 'done: say hi');
    assert.equal(rows.find((row) => row.id === 'boom').ok, false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('sessions export --verified keeps only sessions whose last check passed, redacted', async () => {
  const { appendEvent } = await import('../src/event-stream.mjs');
  const { sessionVerified } = await import('../src/trajectories.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-traj-verified-'));
  const env = { OASIS_CONFIG_DIR: path.join(base, 'cfg') };
  const token = 'ghp_' + 'Q7'.repeat(18);
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'fix it, my token is ' + token }, { role: 'assistant', content: 'Fixed; npm test passes.' }];
  const check = (passed) => ({ type: 'verification', kind: 'test', command: 'npm test', exitCode: passed ? 0 : 1, passed });
  try {
    const passed = await saveSession({ root: base, messages, config: { model: 'm' } }, { env });
    await appendEvent(base, passed.id, check(false), { env });
    await appendEvent(base, passed.id, { type: 'tool_result', id: 'c1', tool: 'edit_file', ok: true }, { env });
    await appendEvent(base, passed.id, check(true), { env });
    const failed = await saveSession({ root: base, messages, config: { model: 'm' } }, { env });
    await appendEvent(base, failed.id, check(false), { env });
    const editedAfter = await saveSession({ root: base, messages, config: { model: 'm' } }, { env });
    await appendEvent(base, editedAfter.id, check(true), { env });
    await appendEvent(base, editedAfter.id, { type: 'tool_result', id: 'c2', tool: 'write_file', ok: true }, { env });
    const neverChecked = await saveSession({ root: base, messages, config: { model: 'm' } }, { env });
    const out = path.join(base, 'verified.jsonl');
    let skipped = -1;
    assert.equal(await exportSessions(base, ['--all', '--verified', '--out', out], { env, onSkipped: (value) => { skipped = value; } }), 1);
    assert.equal(skipped, 3);
    const text = await readFile(out, 'utf8');
    const lines = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.id), [passed.id]);
    assert.ok(!text.includes(token), 'planted token is redacted');
    assert.equal(lines[0].messages.at(-1).content, 'Fixed; npm test passes.');
    // Without --verified every session is exported, as before.
    assert.equal(await exportSessions(base, ['--all', '--out', out], { env }), 4);
    // Explicit IDs are filtered too.
    assert.equal(await exportSessions(base, [neverChecked.id, failed.id, '--verified', '--out', out], { env }), 0);
    assert.equal(sessionVerified([check(true), { type: 'tool_result', tool: 'edit_file', ok: false }]), true, 'a failed edit changes nothing');
    assert.equal(sessionVerified([check(true), { type: 'tool_result', tool: 'read_file', ok: true }]), true);
    assert.equal(sessionVerified([]), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});
