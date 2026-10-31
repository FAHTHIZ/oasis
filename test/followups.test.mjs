import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractFollowups, recordFollowups, loadFollowups, resolveFollowup, followupReminder } from '../src/followups.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

const FINAL = [
  'Fixed the parser bug and ran the tests.',
  '',
  'Not sure about:',
  '- whether Windows paths with spaces are handled',
  '- the retry delay under load',
  '',
  "**Didn't check:** the Electron build",
  '',
  '## Next steps',
  '1. Add a regression test for CRLF input',
  '',
  'Follow-ups: none'
].join('\n');

test('extracts loose ends from common report headings', () => {
  const items = extractFollowups(FINAL);
  assert.deepEqual(items.map((item) => item.text), [
    'whether Windows paths with spaces are handled',
    'the retry delay under load',
    'the Electron build',
    'Add a regression test for CRLF input'
  ]);
  assert.equal(extractFollowups('All done. Tests pass.').length, 0);
});

test('ledger dedupes, resolves by id prefix, and builds a reminder', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-followups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await recordFollowups(root, extractFollowups(FINAL));
  assert.equal(first.length, 4);
  assert.equal((await recordFollowups(root, extractFollowups(FINAL))).length, 0, 'duplicates are not re-added');
  const resolved = await resolveFollowup(root, first[0].id.slice(0, 5));
  assert.equal(resolved.status, 'done');
  const reminder = await followupReminder(root);
  assert.match(reminder, /Open follow-ups/);
  assert.ok(!reminder.includes(first[0].text));
  assert.ok(reminder.includes('the Electron build'));
  const listed = await runBuiltinCommand('followups', '', { root });
  assert.match(listed.output, /\[ \] [0-9a-f]{8} {2}the retry delay/);
});

test('agent turns capture follow-ups and remind the next session once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-followups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: payloads.length === 1 ? FINAL : 'ok' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '' };
  const first = await runAgentTurn(await createSession({ root, config }), 'Fix the parser.');
  assert.equal(first.followupsAdded.length, 4);
  assert.equal((await loadFollowups(root)).length, 4);

  const next = await createSession({ root, config });
  await runAgentTurn(next, 'What is left?');
  const lastUser = payloads[1].messages.filter((message) => message.role === 'user').pop();
  assert.match(String(lastUser.content), /Open follow-ups recorded in earlier sessions/);
  await runAgentTurn(next, 'Another question.');
  const thirdUser = payloads[2].messages.filter((message) => message.role === 'user').pop();
  assert.ok(!String(thirdUser.content).includes('Open follow-ups'), 'reminder is only injected once per session');

  const off = await createSession({ root, config: { ...config, followups: false } });
  await runAgentTurn(off, 'Quiet please.');
  const offUser = payloads[3].messages.filter((message) => message.role === 'user').pop();
  assert.ok(!String(offUser.content).includes('Open follow-ups'));
});
