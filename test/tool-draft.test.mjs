import test from 'node:test';
import assert from 'node:assert/strict';
import { draftTarget, createDraftReporter, describeDraft, formatBytes } from '../src/tool-draft.mjs';
import { readProviderStream } from '../src/provider-stream.mjs';
import { updateTodos } from '../src/tools.mjs';
import { normalizeTaskProgress } from '../app/core/task-progress.mjs';

test('draftTarget reads only completed strings from partial JSON', () => {
  assert.deepEqual(draftTarget('{"path":"src/a.m'), {});
  assert.deepEqual(draftTarget('{"path":"src/a.mjs","content":"x'), { path: 'src/a.mjs' });
  assert.deepEqual(draftTarget('{"command":"npm","args":["test","--","-x"]'), { command: 'npm test -- -x' });
  assert.deepEqual(draftTarget('{"query":"isOverdue"'), { query: 'isOverdue' });
  assert.deepEqual(draftTarget('{"path":"a \\"q\\".txt"}'), { path: 'a "q".txt' });
});

test('the reporter throttles growth but reports a new target at once', () => {
  let t = 0;
  const seen = [];
  const r = createDraftReporter((e) => seen.push(e), { now: () => t, interval: 100 });
  r.update(0, { id: 'c1', name: 'write_file', args: '' });
  r.update(0, { args: '{"path":"src/a.mjs"' });
  r.update(0, { args: '{"path":"src/a.mjs","content":"abc' });
  t = 150;
  r.update(0, { args: '{"path":"src/a.mjs","content":"abcdef' });
  r.finish();
  assert.equal(seen.length, 4);
  assert.equal(seen[1].path, 'src/a.mjs');
  assert.equal(seen.at(-1).done, true);
  assert.equal(seen.at(-1).chars, '{"path":"src/a.mjs","content":"abcdef'.length);
});

test('describeDraft speaks in the present tense', () => {
  assert.equal(describeDraft({ name: 'write_file', path: 'src/big.mjs', chars: 3300 }).text, 'Writing src/big.mjs · 3.2 KB');
  assert.equal(describeDraft({ name: 'run_command', command: 'npm test' }).text, 'Preparing npm test');
  assert.equal(describeDraft({ name: 'todo_write' }).text, 'Updating the plan');
  assert.equal(formatBytes(20480), '20 KB');
});

function sse(lines) {
  const body = lines.map((line) => 'data: ' + JSON.stringify(line) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

test('chat streams report tool drafts while arguments arrive', async () => {
  const drafts = [];
  const res = sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"x.mjs",' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ]);
  const out = await readProviderStream(res, 'openai-compatible', () => {}, null, null, (d) => drafts.push(d));
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'write_file');
  assert.ok(drafts.some((d) => d.path === 'x.mjs'));
  assert.equal(drafts.at(-1).chars, '{"path":"x.mjs","content":"hi"}'.length);
});

test('anthropic streams report tool drafts', async () => {
  const drafts = [];
  const res = sse([
    { type: 'message_start', message: { id: 'm', model: 'c', usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'edit_file', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.js"' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ',"old_string":"a","new_string":"b"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' }
  ]);
  await readProviderStream(res, 'anthropic', () => {}, null, null, (d) => drafts.push(d));
  assert.equal(drafts[0].name, 'edit_file');
  assert.ok(drafts.some((d) => d.path === 'a.js'));
});

test('todo_write keeps activeForm (Claude Code field) for the live label', () => {
  const store = [];
  const out = updateTodos(store, [{ content: 'Run tests', status: 'in_progress', activeForm: 'Running the tests' }, { content: 'Ship', status: 'pending' }]);
  assert.equal(out.todos[0].activeForm, 'Running the tests');
  assert.equal('activeForm' in out.todos[1], false);
  const progress = normalizeTaskProgress(out.todos);
  assert.equal(progress.activeLabel, 'Running the tests');
});
