// The compaction summarizer saw each user message cut to 1,800 characters and
// each tool result to 650, and the oldest lines (the original request) were
// the first to go when the transcript was too long.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryHistoryLine, summaryTranscript } from '../src/compaction-history.mjs';
import { compactHistoryIfNeeded } from '../src/agent.mjs';

test('a long user spec and tool result reach the summarizer with their ends', () => {
  const spec = 'Build it.\n' + 'requirement\n'.repeat(500) + 'LAST REQUIREMENT: keep the API stable';
  assert.match(summaryHistoryLine({ role: 'user', content: spec }), /LAST REQUIREMENT/);
  const output = 'line\n'.repeat(1000) + 'FAILED: test/auth.test.mjs';
  assert.match(summaryHistoryLine({ role: 'tool', name: 'run_command', content: output }), /FAILED: test\/auth/);
  const huge = summaryHistoryLine({ role: 'tool', name: 'read_file', content: 'x'.repeat(50000) });
  assert.ok(huge.length < 4200);
  assert.match(huge, /characters omitted/);
});

test('an over-long transcript keeps the first request and the newest lines', () => {
  const messages = [{ role: 'user', content: 'ORIGINAL TASK: migrate the database' }];
  for (let i = 0; i < 200; i++) messages.push({ role: 'assistant', content: 'step ' + i + ' ' + 'z'.repeat(500) }, { role: 'tool', name: 't', content: 'out ' + i });
  const text = summaryTranscript(messages, 20000);
  assert.ok(text.length <= 20000, String(text.length));
  assert.ok(text.startsWith('USER: ORIGINAL TASK'));
  assert.match(text, /earlier transcript lines omitted/);
  assert.match(text, /out 199$/);
  assert.doesNotMatch(text, /step 0 /);
});

test('compaction sends the summarizer the original request and late details', async () => {
  let seen = '';
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen = body.messages.map((m) => typeof m.content === 'string' ? m.content : '').join('\n');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Summary: the user wants the database migrated; the auth test failed and still needs a fix.' } }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'ORIGINAL TASK ' + 'detail '.repeat(600) + 'END OF SPEC' }];
  for (let i = 0; i < 40; i++) messages.push({ role: 'assistant', content: 'working ' + i }, { role: 'user', content: 'more ' + i + ' ' + 'q'.repeat(3000) });
  const session = { config: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'gpt-4o' }, messages, toolDefinitions: [] };
  const result = await compactHistoryIfNeeded(session, { force: true, fetchImpl, persistSessionNotes: false, env: {} });
  assert.equal(result.compacted, true);
  assert.match(seen, /END OF SPEC/);
});
