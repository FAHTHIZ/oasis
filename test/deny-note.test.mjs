import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverDenyNote } from '../src/deny-note.mjs';
import { agentRegistry } from '../src/agent-tasks.mjs';

test('a Deny note goes to the agent that asked, else steers the main agent', () => {
  const session = { root: '/tmp' };
  const registry = agentRegistry(session);
  const child = { inbox: [] };
  registry.agents.set('agent_1', { id: 'agent_1', description: 'Run npm test', status: 'running', child });
  registry.agents.set('agent_0', { id: 'agent_0', description: 'Old run', status: 'completed', child: { inbox: [] } });
  const steered = [];
  const steer = (text) => { steered.push(text); return true; };
  assert.equal(deliverDenyNote(session, { subagent: 'Run npm test', note: 'Read cart.test.js instead' }, { steer }), 'agent');
  assert.match(child.inbox[0].text, /denied your last request and said:\nRead cart\.test\.js instead/);
  assert.deepEqual(steered, []);
  // A finished agent cannot take it; nor can an unknown one. The main agent does.
  assert.equal(deliverDenyNote(session, { subagent: 'Old run', note: 'x' }, { steer }), 'main');
  assert.equal(deliverDenyNote(session, { note: 'y' }, { steer }), 'main');
  assert.deepEqual(steered, ['x', 'y']);
  assert.equal(deliverDenyNote(session, { note: '   ' }, { steer }), '');
  assert.equal(deliverDenyNote(session, { note: 'z' }, { steer: () => false }), '');
  assert.equal(deliverDenyNote(session, { note: 'n'.repeat(5000) }, { steer }), 'main');
  assert.equal(steered.at(-1).length, 2000);
});
