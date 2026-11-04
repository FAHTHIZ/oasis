import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, budgetNotice } from '../src/agent.mjs';
import { BudgetExceededError } from '../src/pricing.mjs';

// Each request reports 10 prompt tokens; at $40,000 per million input tokens
// that is $0.40 per request, so a $1 budget allows two requests in total.
async function fanOut(t, { budget }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'agents', 'scout.md'), '---\nname: scout\ndescription: Finds files\n---\nYou find files.\n');
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    payloads.push(payload);
    const isChild = /You find files/.test(payload.messages[0].content);
    const hasTaskResult = payload.messages.some((m) => m.role === 'tool');
    const message = isChild ? { role: 'assistant', content: 'found it' }
      : hasTaskResult ? { role: 'assistant', content: 'all done' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'find', prompt: 'find the config', subagent_type: 'scout' }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_PRICE_INPUT: '40000', OASIS_PRICE_OUTPUT: '0' };
  const session = await createSession({ root, env, maxBudgetUsd: budget, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  let error = null;
  try { await runAgentTurn(session, 'go', { autoApprove: true, env }); } catch (e) { error = e; }
  return { session, payloads, error };
}

test('subagent spend counts toward the parent --max-budget-usd', async (t) => {
  const { session, payloads, error } = await fanOut(t, { budget: 1 });
  assert.ok(payloads.some((p) => /You find files/.test(p.messages[0].content)), 'the subagent ran');
  assert.ok(error instanceof BudgetExceededError, 'parent + subagent spend ($1.20) must stop a $1 run; without a shared ledger the parent alone only saw $0.80');
  assert.ok(session.budgetLedger.spentUsd >= 1);
});

test('with room in the budget the whole task, including subagents, is on one ledger', async (t) => {
  const { session, error } = await fanOut(t, { budget: 5 });
  assert.equal(error, null);
  assert.ok(Math.abs(session.budgetLedger.spentUsd - 1.2) < 1e-9, 'three requests at $0.40: ' + session.budgetLedger.spentUsd);
  assert.ok(Math.abs(session.costUsd - 0.8) < 1e-9, 'costUsd stays the main agent\'s own spend');
});

test('the model is told once at 75% and once at 90% of the budget', () => {
  const session = { maxBudgetUsd: 10 };
  assert.equal(budgetNotice(session, 5), '');
  assert.match(budgetNotice(session, 7.6), /\$7\.60 of the \$10\.00.*\$2\.40 left.*avoid broad exploration/s);
  assert.equal(budgetNotice(session, 8), '', 'no repeat at the same level');
  assert.match(budgetNotice(session, 9.2), /Finish the current change now.*Do not start new work or launch subagents/s);
  assert.equal(budgetNotice(session, 9.9), '');
  assert.equal(budgetNotice({ maxBudgetUsd: 0 }, 100), '', 'no budget, no notice');
});
