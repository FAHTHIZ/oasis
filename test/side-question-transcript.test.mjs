// /btw and the advisor see the newest whole transcript lines, with a note
// when older ones were left out, and the question itself is never cut short.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recentTranscript, askSideQuestion } from '../src/agent.mjs';

const session = (messages) => ({ messages: [{ role: 'system', content: 's' }, ...messages] });

test('recentTranscript keeps whole newest lines and says how many were left out', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: 'line ' + i + ' ' + 'x'.repeat(50) }));
  const out = recentTranscript(session(msgs), 200);
  assert.ok(out.length <= 240);
  assert.match(out, /^\[\d+ earlier transcript lines omitted\]/);
  assert.match(out, /line 9 x+$/);
  for (const line of out.split('\n').slice(1)) assert.match(line, /^USER: line \d x{50}$/);
  assert.equal(recentTranscript(session(msgs.slice(0, 2)), 10000).split('\n').length, 2);
});

test('a single huge newest line keeps its end', () => {
  const out = recentTranscript(session([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b'.repeat(1000) + 'END' }]), 100);
  assert.match(out, /^\[1 earlier transcript line omitted\]\n…b+END$/);
});

test('a long side question reaches the model whole', async () => {
  let sent = '';
  const question = 'Q'.repeat(20000) + ' TAIL?';
  const s = session([{ role: 'user', content: 'hi' }]);
  s.config = { model: 'm', baseURL: 'http://x.test/v1', apiKey: 'k' };
  s.providerEnv = { OASIS_TEST_FETCH: '1' };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body).messages.at(-1).content; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try { assert.equal(await askSideQuestion(s, question), 'ok'); } finally { globalThis.fetch = original; }
  assert.ok(sent.endsWith(question));
});
