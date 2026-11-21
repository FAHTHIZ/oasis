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

test('hermes format: generated <tools> system turn, <think> and <tool_call> in gpt turns, grouped <tool_response>', async () => {
  const { hermesFromRecord, HERMES_SYSTEM_PREFIX } = await import('../src/trajectories.mjs');
  const messages = [
    { role: 'system', content: 'OASIS system prompt' },
    { role: 'user', content: 'what is in here?' },
    { role: 'assistant', content: '', reasoning_content: 'List then read.', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
      { id: 'c2', type: 'function', function: { name: 'read_file', arguments: 'not json' } }
    ] },
    { role: 'tool', tool_call_id: 'c1', name: 'list_files', content: '{"ok":true,"files":["a.js"]}' },
    { role: 'tool', tool_call_id: 'c2', content: '{"ok":false,"error":"ENOENT"}' },
    { role: 'assistant', content: 'One file: a.js.' }
  ];
  const record = hermesFromRecord(toOpenAIRecord({ id: 'h1', messages, model: 'm' }, [{ type: 'function', function: { name: 'list_files', description: 'List', parameters: { type: 'object', properties: {} } } }, { type: 'function', function: { name: 'write_file', description: 'Write', parameters: {} } }]));
  assert.deepEqual(record.conversations.map((turn) => turn.from), ['system', 'human', 'gpt', 'tool', 'gpt']);
  const system = record.conversations[0].value;
  assert.ok(system.startsWith(HERMES_SYSTEM_PREFIX));
  assert.doesNotMatch(system, /OASIS system prompt/);
  const tools = JSON.parse(system.match(/<tools>\n([\s\S]*?)\n<\/tools>/)[1]);
  assert.deepEqual(tools[0], { name: 'list_files', description: 'List', parameters: { type: 'object', properties: {} }, required: null });
  assert.match(system, /Each function call should be enclosed within <tool_call> <\/tool_call> XML tags\./);
  assert.equal(record.conversations[2].value, '<think>\nList then read.\n</think>\n<tool_call>\n{"name": "list_files", "arguments": {"path": "."}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {}}\n</tool_call>');
  const responses = record.conversations[3].value.split('\n</tool_response>\n<tool_response>\n');
  assert.equal(responses.length, 2);
  assert.match(record.conversations[3].value, /^<tool_response>\n\{"tool_call_id": "c1", "name": "list_files", "content": \{"ok": true, "files": \["a\.js"\]\}\}/);
  assert.match(record.conversations[3].value, /"name": "read_file", "content": \{"ok": false, "error": "ENOENT"\}/);
  assert.equal(record.conversations[4].value, '<think>\n</think>\nOne file: a.js.');
  assert.deepEqual(record.tool_stats, { list_files: { count: 1, success: 1, failure: 0 }, write_file: { count: 0, success: 0, failure: 0 }, read_file: { count: 1, success: 0, failure: 1 } });
  assert.deepEqual(record.tool_error_counts, { list_files: 0, write_file: 0, read_file: 1 });
  assert.equal(record.completed, true);
  assert.equal(record.api_calls, 2);
});

test('sessions export --format hermes fills tool schemas from the built-in tools', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-hermes-'));
  const env = { OASIS_CONFIG_DIR: path.join(base, 'cfg') };
  try {
    const saved = await saveSession({ root: base, messages: convo, config: { model: 'm' } }, { env });
    let printed = '';
    await exportSessions(base, [saved.id, '--format', 'hermes'], { env, stdout: { write: (text) => { printed += text; } } });
    const record = JSON.parse(printed);
    const tools = JSON.parse(record.conversations[0].value.match(/<tools>\n([\s\S]*?)\n<\/tools>/)[1]);
    assert.deepEqual(tools.map((tool) => tool.name), ['list_files']);
    assert.ok(tools[0].description.length > 10);
    assert.ok(!printed.includes('a'.repeat(36)));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
