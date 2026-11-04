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
