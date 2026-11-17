import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildNeuronNetworkSnapshot, projectBudget, formatBudget } from '../src/neuron-network.mjs';
import { createBudget, reserve, spend } from '../src/budget-algebra.mjs';
import { shutdownTelemetry } from '../src/telemetry.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// Roadmap 2.6: the network view shows each neuron's budget, spend and what is left.

test('projectBudget: live runs add the open reservation to earlier spend', () => {
  assert.equal(projectBudget({}), null, 'no budget and no spend: no field');
  const root = createBudget({ tokens: 10000, usd: 1 });
  const node = reserve(root, { tokens: 4000, usd: 0.5 }, { name: 'agent_1' });
  spend(node, { tokens: 1500, usd: 0.125 });
  const record = { budgetLimits: { tokens: 5000, usd: 0.5 }, budgetSpent: { tokens: 1000 }, child: { budgetNode: node } };
  assert.deepEqual(projectBudget(record), {
    tokens: { spent: 2500, limit: 5000, left: 2500 },
    usd: { spent: 0.125, limit: 0.5, left: 0.375 }
  });
  assert.equal(formatBudget(projectBudget(record)), 'budget tokens 2,500/5,000, usd $0.13/$0.50');
  // Finished agent: only stored spend; kinds without a limit still show spend.
  assert.deepEqual(projectBudget({ budgetSpent: { requests: 3, steps: 0 } }), { requests: { spent: 3 } });
});

test('snapshot: neuron_network carries budgets without exposing prompts or reports', () => {
  const start = Date.UTC(2026, 10, 17);
  const agents = new Map([
    ['agent_1', { id: 'agent_1', parentId: 'main', depth: 1, type: 'researcher', description: 'Survey', status: 'completed', startedAt: start, finishedAt: start + 9000, toolCalls: 4, usage: { totalTokens: 1200, costUsd: 0.01 }, budgetLimits: { tokens: 5000 }, budgetSpent: { tokens: 1200, requests: 2 }, prompt: 'SECRET PROMPT', report: 'SECRET REPORT' }],
    ['agent_2', { id: 'agent_2', parentId: 'agent_1', depth: 2, type: 'general-purpose', description: 'Read docs', status: 'failed', startedAt: start + 1000, finishedAt: start + 3000, toolCalls: 1, tokensUsed: 50 }]
  ]);
  const snapshot = buildNeuronNetworkSnapshot({ agents });
  const text = JSON.stringify(snapshot);
  assert.doesNotMatch(text, /SECRET/);
  assert.deepEqual(snapshot.nodes.map((node) => [node.id, node.parent_id, node.status, node.budget || null]), [
    ['main', null, 'running', null],
    ['agent_1', 'main', 'completed', { tokens: { spent: 1200, limit: 5000, left: 3800 }, requests: { spent: 2 } }],
    ['agent_2', 'agent_1', 'failed', null]
  ]);
  assert.equal(snapshot.nodes[1].elapsed_seconds, 9);
  assert.deepEqual(snapshot.edges, [{ from: 'main', to: 'agent_1', relation: 'spawned' }, { from: 'agent_1', to: 'agent_2', relation: 'spawned' }]);
});

test('telemetry: subagent invoke_agent spans carry the neuron id, parent id and depth', async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { if (req.url.endsWith('/traces')) received.push(JSON.parse(body)); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-neuron-otel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.cfg'), OASIS_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: '', OTEL_EXPORTER_OTLP_TRACES_HEADERS: '', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:' + server.address().port, OTEL_SEMCONV_STABILITY_OPT_IN: '' };
  const { config } = await scriptedModel(t, [
    (payload) => payload.messages[0].content.includes('SUBAGENT MODE') ? { content: 'child done' } : payload.messages.some((m) => m.role === 'tool') ? { content: 'parent done' } : toolCall('t1', 'task', { description: 'look', prompt: 'look around' })
  ]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'delegate', { autoApprove: true, env });
  await shutdownTelemetry();
  const spans = received.flatMap((p) => p.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
  const attr = (span, key) => { const a = span.attributes.find((x) => x.key === key); return a && (a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue); };
  const turn = spans.find((s) => s.name === 'oasis.turn');
  const child = spans.find((s) => s.name === 'oasis.subagent_turn');
  assert.ok(turn && child, spans.map((s) => s.name).join(', '));
  assert.equal(attr(turn, 'oasis.neuron.id'), 'main');
  assert.equal(attr(child, 'gen_ai.operation.name'), 'invoke_agent');
  assert.equal(attr(child, 'oasis.neuron.id'), 'agent_1');
  assert.equal(attr(child, 'oasis.neuron.parent_id'), 'main');
  assert.equal(Number(attr(child, 'oasis.neuron.depth')), 1);
  assert.equal(child.traceId, turn.traceId, 'the child span is in the parent turn trace');
});

test('agent events carry the budget line the web app shows', async () => {
  const { recordAgentEvent, agentRegistry } = await import('../src/agent-tasks.mjs');
  const session = { agentId: 'main' };
  const registry = agentRegistry(session);
  registry.agents.set('agent_1', { id: 'agent_1', status: 'running', budgetLimits: { tokens: 50000 }, budgetSpent: { tokens: 1200 } });
  const seen = [];
  session.onAgentEvent = (event) => seen.push(event);
  recordAgentEvent(session, 'agent.completed', { agentId: 'agent_1', description: 'x' });
  assert.equal(seen[0].budget, 'tokens 1,200/50,000');
  recordAgentEvent(session, 'team.created', {});
  assert.equal(seen[1].budget, undefined);
});
