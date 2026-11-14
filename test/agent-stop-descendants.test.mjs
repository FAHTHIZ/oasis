import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRegistry, registerAgent, stopAgent, stopDescendants } from '../src/agent-tasks.mjs';
import { descendantRecords } from '../src/neuron-network.mjs';

// main -> agent_1 -> agent_2 -> agent_3, plus a sibling agent_4 under main.
function tree() {
  const main = { sessionId: 's', messages: [] };
  const live = (session, description) => { const r = registerAgent(session, { type: 'general-purpose', description, background: true }); r.controller = new AbortController(); return r; };
  const a1 = live(main, 'lead');
  const c1 = { agentTasks: agentRegistry(main), agentId: a1.id };
  const a2 = live(c1, 'worker');
  const c2 = { agentTasks: agentRegistry(main), agentId: a2.id };
  const a3 = live(c2, 'leaf');
  const a4 = live(main, 'sibling');
  return { main, a1, a2, a3, a4 };
}

test('descendantRecords follows the lineage nearest first', () => {
  const { main, a1, a2, a3, a4 } = tree();
  assert.deepEqual(descendantRecords(agentRegistry(main), a1.id).map((r) => r.id), [a2.id, a3.id]);
  assert.deepEqual(descendantRecords(agentRegistry(main), a4.id), []);
});

test('agent_stop reaches every running descendant and nothing else', () => {
  const { main, a1, a2, a3, a4 } = tree();
  const result = stopAgent(main, { id: a1.id });
  assert.deepEqual(result.descendantsStopped, [a2.id, a3.id]);
  assert.match(result.message, /Also stopped 2 agent/);
  for (const r of [a1, a2, a3]) assert.equal(r.controller.signal.aborted, true, r.id);
  assert.equal(a4.controller.signal.aborted, false, 'the sibling keeps running');
});

test('a finished agent stops background agents it never waited for', () => {
  const { main, a1, a2, a3 } = tree();
  a1.status = 'completed';
  a3.status = 'completed';
  const stopped = stopDescendants(main, a1, 'the agent that started it finished without waiting for it');
  assert.deepEqual(stopped, [a2.id], 'only running descendants are stopped');
  assert.equal(a2.stopReason, 'the agent that started it finished without waiting for it');
  assert.equal(a3.controller.signal.aborted, false);
});
