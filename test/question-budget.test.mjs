import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';

const ask = (id) => ({ id, type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ question: 'Which one ' + id + '?', options: [{ label: 'A' }, { label: 'B' }] }) } });

async function run(t, { env = {}, config = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-questions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let n = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    n++;
    const message = n <= 3 ? { role: 'assistant', content: null, tool_calls: [ask('q' + n)] } : { role: 'assistant', content: 'done' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8, ...config } });
  const asked = [];
  await runAgentTurn(session, 'go', { autoApprove: true, env: { ...process.env, ...env }, askUser: async (question) => { asked.push(question.question); return '1'; } });
  const results = session.messages.filter((m) => m.role === 'tool' && m.name === 'ask_user_question').map((m) => JSON.parse(m.content));
  return { asked, results, session };
}

test('only two questions per turn reach the user by default', async (t) => {
  const { asked, results } = await run(t);
  assert.deepEqual(asked, ['Which one q1?', 'Which one q2?']);
  assert.equal(results[2].questionBudgetExceeded, true);
  assert.match(results[2].message, /choose the most reasonable option yourself/);
});

test('the question cap is configurable and can be turned off', async (t) => {
  assert.equal((await run(t, { env: { OASIS_MAX_QUESTIONS_PER_TURN: 'off' } })).asked.length, 3);
  assert.equal((await run(t, { env: { OASIS_MAX_QUESTIONS_PER_TURN: '1' } })).asked.length, 1);
  assert.equal((await run(t, { config: { maxQuestionsPerTurn: 0 } })).asked.length, 0);
});
