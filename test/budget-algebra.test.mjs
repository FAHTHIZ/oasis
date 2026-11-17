import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_KINDS, BudgetLimitError, available, budgetSnapshot, canSpend, childBudgetRequest,
  close, committed, createBudget, reserve, spend
} from '../src/budget-algebra.mjs';

test('a reservation counts against the parent at once and is refunded on close', () => {
  const root = createBudget({ tokens: 1000 });
  const child = reserve(root, { tokens: 600 }, { name: 'a' });
  assert.equal(child.limits.tokens, 600);
  assert.equal(available(root, 'tokens'), 400);
  // A sibling can only get what is left.
  const sibling = reserve(root, { tokens: 900 }, { name: 'b' });
  assert.equal(sibling.limits.tokens, 400);
  assert.equal(available(root, 'tokens'), 0);
  spend(child, { tokens: 250 });
  assert.equal(available(child, 'tokens'), 350);
  assert.equal(root.spent.tokens, 250);
  const refund = close(child);
  assert.equal(refund.tokens, 350);
  assert.equal(committed(root, 'tokens'), 250 + 400);
  close(sibling);
  assert.equal(available(root, 'tokens'), 750);
});

test('a child cannot spend past its grant, and a grandchild is bounded by every ancestor', () => {
  const root = createBudget({ usd: 1 });
  const child = reserve(root, { usd: 0.5 });
  const grandchild = reserve(child);
  assert.equal(grandchild.limits.usd, Infinity);
  assert.equal(available(grandchild, 'usd'), 0.5);
  spend(grandchild, { usd: 0.4 });
  assert.throws(() => spend(grandchild, { usd: 0.2 }), (error) => error instanceof BudgetLimitError && error.kind === 'usd' && error.code === 'NEURON_BUDGET_EXCEEDED');
  // A refused charge changes nothing.
  assert.equal(child.spent.usd, 0.4);
  assert.equal(root.spent.usd, 0.4);
  assert.equal(canSpend(grandchild, 'usd', 0.1), true);
  assert.equal(canSpend(grandchild, 'usd', 0.11), false);
});

test('children is a budget too, and a root limit caps the whole tree', () => {
  const root = createBudget({ children: 3 });
  const a = reserve(root);
  reserve(a);
  reserve(a);
  assert.throws(() => reserve(root), (error) => error.kind === 'children');
  assert.throws(() => reserve(a), (error) => error.kind === 'children');
});

test('forced charges are recorded past a limit and stop later checked charges', () => {
  const root = createBudget({ tokens: 100 });
  const child = reserve(root, { tokens: 50 });
  spend(child, { tokens: 80 }, { force: true });
  assert.equal(root.spent.tokens, 80);
  assert.equal(canSpend(child, 'tokens', 0), false);
  assert.throws(() => spend(child, { tokens: 1 }), BudgetLimitError);
  // The root still has 20 for another child.
  close(child);
  assert.equal(available(root, 'tokens'), 20);
});

test('a descendant that outlives its parent stays bounded by every ancestor', () => {
  const root = createBudget({ steps: 10 });
  const a = reserve(root, { steps: 6 });
  const b = reserve(a, { steps: 4 });
  spend(b, { steps: 1 });
  close(a);
  assert.equal(a.closed, true);
  assert.equal(b.closed, false);
  assert.throws(() => spend(a, { steps: 1 }), /closed/);
  // b keeps its own limit of 4 and cannot pass the root either.
  spend(b, { steps: 3 });
  assert.throws(() => spend(b, { steps: 1 }), BudgetLimitError);
  assert.equal(budgetSnapshot(root).available.steps, 6);
  const sibling = reserve(root, { steps: 9 });
  assert.equal(sibling.limits.steps, 6);
});

test('childBudgetRequest reads the env default and the definition wins per kind', () => {
  assert.equal(childBudgetRequest({}, {}), null);
  assert.deepEqual(childBudgetRequest({}, { OASIS_SUBAGENT_BUDGET: 'tokens=5000, usd=0.25 bogus=3' }), { tokens: 5000, usd: 0.25 });
  assert.deepEqual(childBudgetRequest({ budget: { tokens: 10 } }, { OASIS_SUBAGENT_BUDGET: 'tokens=5000,requests=4' }), { tokens: 10, requests: 4 });
});

// Property: random concurrent spawn trees never pass their root's budget, and
// once every neuron has ended, the root holds nothing back for them.
function rng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

function checkInvariant(node) {
  for (const kind of BUDGET_KINDS) {
    assert.ok(committed(node, kind) <= node.limits[kind] + 1e-9, node.name + ' committed ' + committed(node, kind) + ' ' + kind + ' of ' + node.limits[kind]);
  }
  for (const child of node.children) checkInvariant(child);
}

test('property: random concurrent spawn trees stay within the root budget and refund on cancel', async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const random = rng(seed * 7919);
    const rootLimits = { tokens: 2000 + Math.floor(random() * 4000), usd: 1 + random() * 3, requests: 30 + Math.floor(random() * 50), steps: 40 + Math.floor(random() * 60), children: 6 + Math.floor(random() * 20) };
    const root = createBudget(rootLimits, { name: 'root' });
    let ids = 0;
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const neuron = async (budget, depth) => {
      const kids = [];
      const actions = 2 + Math.floor(random() * 8);
      try {
        for (let i = 0; i < actions; i++) {
          await tick();
          if (budget.closed) break;
          if (depth < 4 && random() < 0.35) {
            const request = {};
            for (const kind of BUDGET_KINDS) if (random() < 0.5) request[kind] = random() * rootLimits[kind] * 0.6;
            try {
              const child = reserve(budget, request, { name: 'n' + (++ids) });
              kids.push({ child, run: neuron(child, depth + 1) });
            } catch (error) { assert.ok(error instanceof BudgetLimitError, String(error)); }
          } else {
            const amounts = { tokens: random() * 400, usd: random() * 0.4, requests: 1, steps: 1 };
            try { spend(budget, amounts); } catch (error) { assert.ok(error instanceof BudgetLimitError, String(error)); }
          }
          checkInvariant(root);
          // Cancel a random child: what it did not spend comes back.
          if (kids.length && random() < 0.15) {
            const victim = kids[Math.floor(random() * kids.length)].child;
            if (!victim.closed) {
              const before = committed(budget, 'tokens');
              const held = Number.isFinite(victim.limits.tokens) ? Math.max(0, victim.limits.tokens - victim.spent.tokens) : 0;
              close(victim);
              assert.ok(Math.abs(committed(budget, 'tokens') - (before - held)) < 1e-6, 'cancel refunds the unspent reservation');
            }
          }
        }
        await Promise.all(kids.map((kid) => kid.run));
      } finally {
        if (budget !== root) close(budget);
      }
    };
    await neuron(root, 0);
    checkInvariant(root);
    for (const kind of BUDGET_KINDS) {
      assert.ok(root.spent[kind] <= rootLimits[kind] + 1e-9, 'seed ' + seed + ': root spent ' + root.spent[kind] + ' ' + kind);
      assert.ok(Math.abs(committed(root, kind) - root.spent[kind]) < 1e-9, 'seed ' + seed + ': every reservation was refunded (' + kind + ')');
    }
  }
});

// End to end: an agent definition's budget is reserved from the main session
// and stops the subagent before the request that would pass it.
test('a subagent stops at its own budgetRequests and the main session gets the rest back', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { createSession, runAgentTurn } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-budget-algebra-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'agents', 'scout.md'), '---\nname: scout\ndescription: Finds files\nbudgetRequests: 2\n---\nYou find files.\n');
  let childRequests = 0;
  let taskResult = '';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    const isChild = /You find files/.test(payload.messages[0].content);
    const toolMessage = payload.messages.find((m) => m.role === 'tool');
    let message;
    if (isChild) {
      childRequests++;
      // The scout never finishes on its own: it lists files forever.
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'l' + childRequests, type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] };
    } else if (toolMessage) {
      taskResult = String(toolMessage.content);
      message = { role: 'assistant', content: 'all done' };
    } else {
      message = { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'find', prompt: 'find the config', subagent_type: 'scout' }) } }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_NEURON_LEDGER: '0' };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 12 } });
  const outcome = await runAgentTurn(session, 'go', { autoApprove: true, env });
  assert.equal(childRequests, 2, 'the scout made exactly its two requests');
  assert.match(taskResult, /requests budget/);
  assert.equal(outcome.text || outcome.finalText || 'all done', 'all done');
  const node = session.budgetNode;
  assert.ok(node, 'the main session has a budget node');
  assert.equal(node.spent.children, 1);
  for (const kind of BUDGET_KINDS) assert.equal(committed(node, kind), node.spent[kind], 'nothing is still held for the scout (' + kind + ')');
});

test('agent definitions read budgetTokens, budgetUsd, budgetRequests, budgetSteps and budgetChildren', async () => {
  const { normalizeAgentDefinition } = await import('../src/subagents.mjs');
  const definition = normalizeAgentDefinition({ name: 'x', 'budget-tokens': '5000', budgetUsd: '0.25', budgetSteps: 7, budgetChildren: 0, budgetRequests: 'lots' }, 'body', { name: 'x', source: 'test' });
  assert.deepEqual(definition.budget, { tokens: 5000, usd: 0.25, steps: 7, children: 0 });
  assert.equal(normalizeAgentDefinition({ name: 'y' }, 'body', { name: 'y', source: 'test' }).budget, null);
});
