import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openNeuronLedger, reduceNeuronLedger, closeNeuronLedgers } from '../src/neuron-ledger.mjs';
import { registerAgent, addAgentUsage, recordAgentEvent, restoreAgentHistory, agentRegistry } from '../src/agent-tasks.mjs';
import { buildNeuronNetworkSnapshot } from '../src/neuron-network.mjs';

const ledgerModule = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'neuron-ledger.mjs')).href;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-ledger-'));
  t.after(async () => { closeNeuronLedgers(); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

function sessionFor(file, sessionId = 'session-1') {
  return { sessionId, createEnv: { OASIS_NEURON_LEDGER_FILE: file } };
}

// A clean run of a small network: two top-level workers, one with a child,
// usage charged along the way, and every neuron reaching a final state.
const CLEAN_RUN = [
  { kind: 'spawn', neuronId: 'agent_1', parentId: 'main', depth: 1, role: 'explore', description: 'map the repo' },
  { kind: 'spawn', neuronId: 'agent_2', parentId: 'main', depth: 1, role: 'general-purpose', description: 'fix the bug' },
  { kind: 'charge', neuronId: 'agent_1', tokens: 1200, costUsd: 0.002, requests: 1 },
  { kind: 'spawn', neuronId: 'agent_3', parentId: 'agent_2', depth: 2, role: 'test-runner', description: 'run the tests' },
  { kind: 'charge', neuronId: 'agent_2', tokens: 900, costUsd: 0.001, requests: 1 },
  { kind: 'transition', neuronId: 'agent_1', status: 'completed' },
  { kind: 'charge', neuronId: 'agent_3', tokens: 400, costUsd: 0.0005, requests: 1 },
  { kind: 'transition', neuronId: 'agent_3', status: 'failed' },
  { kind: 'transition', neuronId: 'agent_2', status: 'completed' }
];

function graph(registry) {
  const snapshot = buildNeuronNetworkSnapshot(registry, { limit: 100 });
  return {
    edges: snapshot.edges.map((edge) => edge.from + '>' + edge.to).sort(),
    statuses: Object.fromEntries(snapshot.nodes.filter((node) => node.id !== 'main').map((node) => [node.id, node.status]))
  };
}

test('the ledger is append-only and folds rows into neuron states', async (t) => {
  const dir = await tempDir(t);
  const ledger = openNeuronLedger(path.join(dir, 'ledger.sqlite'));
  t.after(() => ledger.close());
  for (const row of CLEAN_RUN) ledger.append('s', row);
  const neurons = reduceNeuronLedger(ledger.rows('s'));
  assert.deepEqual([...neurons.keys()], ['agent_1', 'agent_2', 'agent_3']);
  assert.equal(neurons.get('agent_3').parentId, 'agent_2');
  assert.equal(neurons.get('agent_3').status, 'failed');
  assert.equal(neurons.get('agent_1').tokens, 1200);
  assert.equal(neurons.get('agent_2').requests, 1);
  assert.deepEqual(ledger.rows('other'), [], 'sessions are kept apart');

  // Rows cannot be edited, only whole stale sessions pruned.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(ledger.file);
  t.after(() => raw.close());
  assert.throws(() => raw.exec("UPDATE neuron_events SET status = 'running'"), /append-only/);
  assert.equal(ledger.prune(Date.now() + 31 * 24 * 60 * 60 * 1000), 1);
  assert.deepEqual(ledger.rows('s'), []);
});

test('kill at every write: after restart no neuron is running and the graph matches the clean run', async (t) => {
  const dir = await tempDir(t);
  // The clean run, replayed to the end, gives the reference graph.
  const cleanFile = path.join(dir, 'clean.sqlite');
  const clean = openNeuronLedger(cleanFile);
  for (const row of CLEAN_RUN) clean.append('session-1', row);
  clean.close();
  const referenceSession = sessionFor(cleanFile);
  assert.equal(restoreAgentHistory(referenceSession, []).length, 3);
  const cleanGraph = graph(agentRegistry(referenceSession));
  closeNeuronLedgers();

  for (let cut = 0; cut <= CLEAN_RUN.length; cut++) {
    // The process died right after write number `cut`.
    const file = path.join(dir, 'cut-' + cut + '.sqlite');
    const ledger = openNeuronLedger(file);
    for (const row of CLEAN_RUN.slice(0, cut)) ledger.append('session-1', row);
    ledger.close();

    const session = sessionFor(file);
    restoreAgentHistory(session, []);
    const registry = agentRegistry(session);
    const after = graph(registry);
    const spawned = new Set(CLEAN_RUN.slice(0, cut).filter((row) => row.kind === 'spawn').map((row) => row.neuronId));
    assert.deepEqual([...registry.agents.keys()].sort(), [...spawned].sort(), 'cut ' + cut + ': every spawned neuron is back');
    for (const record of registry.agents.values()) assert.notEqual(record.status, 'running', 'cut ' + cut + ': ' + record.id + ' must not be running');
    assert.deepEqual(after.edges, cleanGraph.edges.filter((edge) => spawned.has(edge.split('>')[1])), 'cut ' + cut + ': same lineage as the clean run');
    for (const [id, status] of Object.entries(after.statuses)) {
      const finished = CLEAN_RUN.slice(0, cut).some((row) => row.kind === 'transition' && row.neuronId === id);
      assert.equal(status, finished ? cleanGraph.statuses[id] : 'interrupted', 'cut ' + cut + ': ' + id);
    }
    assert.ok(registry.next > Math.max(0, ...[...spawned].map((id) => Number(id.split('_')[1]))), 'new ids never reuse a recovered one');
    // Recovery is itself recorded, so a second restart sees the same result.
    closeNeuronLedgers();
    const again = sessionFor(file);
    restoreAgentHistory(again, []);
    assert.deepEqual(graph(agentRegistry(again)), after, 'cut ' + cut + ': a second restart agrees');
    closeNeuronLedgers();
  }
});

test('a ledger written by a process killed with SIGKILL reopens and recovers', { skip: process.platform === 'win32' && 'SIGKILL semantics differ on Windows' }, async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'killed.sqlite');
  const script = `
    const { openNeuronLedger } = await import(${JSON.stringify(ledgerModule)});
    const ledger = openNeuronLedger(${JSON.stringify(file)});
    let n = 0;
    for (;;) {
      n++;
      ledger.append('s', { kind: 'spawn', neuronId: 'agent_' + n, parentId: n > 1 ? 'agent_' + (n - 1) : 'main', depth: Math.min(n, 32) });
      ledger.append('s', { kind: 'charge', neuronId: 'agent_' + n, tokens: 10 });
      if (n % 2 === 0) ledger.append('s', { kind: 'transition', neuronId: 'agent_' + n, status: 'completed' });
      if (n === 20) process.stdout.write('ready\\n');
      if (n > 20000) await new Promise((resolve) => setTimeout(resolve, 1000000));
    }`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
    child.on('exit', (code) => reject(new Error('writer exited early with ' + code)));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));

  const ledger = openNeuronLedger(file);
  t.after(() => ledger.close());
  const neurons = reduceNeuronLedger(ledger.rows('s'), { recover: true });
  assert.ok(neurons.size >= 20);
  for (const neuron of neurons.values()) {
    assert.ok(['completed', 'interrupted'].includes(neuron.status), neuron.id + ' is ' + neuron.status);
    if (Number(neuron.id.split('_')[1]) % 2 === 1) assert.equal(neuron.status, 'interrupted');
  }
});

test('the registry writes spawns, transitions and charges to the ledger', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'live.sqlite');
  const session = sessionFor(file, 'live');
  const record = registerAgent(session, { type: 'explore', description: 'look around' });
  addAgentUsage(record, { totalTokens: 300, costUsd: 0.01 });
  addAgentUsage(record, { totalTokens: 50, costUsd: 0.001, phase: 'compaction' });
  record.status = 'completed';
  recordAgentEvent(session, 'agent.completed', { agentId: record.id });
  recordAgentEvent(session, 'agent.message_queued', { agentId: record.id, detail: 'not a transition' });

  const ledger = openNeuronLedger(file);
  t.after(() => ledger.close());
  const rows = ledger.rows('live');
  assert.deepEqual(rows.map((row) => row.kind), ['spawn', 'charge', 'charge', 'transition']);
  const neuron = reduceNeuronLedger(rows).get(record.id);
  assert.equal(neuron.status, 'completed');
  assert.equal(neuron.tokens, 350);
  assert.equal(neuron.requests, 1, 'a usage phase is not a separate request');
  assert.ok(Math.abs(neuron.costUsd - 0.011) < 1e-9);
  assert.ok(!JSON.stringify(record).includes('ledger'), 'nothing ledger-related is serialized with the record');
});

test('no session id or OASIS_NEURON_LEDGER=0 writes nothing', async (t) => {
  const dir = await tempDir(t);
  const unsaved = path.join(dir, 'unsaved.sqlite');
  registerAgent({ sessionId: null, createEnv: { OASIS_NEURON_LEDGER_FILE: unsaved } }, { type: 'explore' });
  assert.equal(existsSync(unsaved), false);
  const off = path.join(dir, 'off.sqlite');
  registerAgent({ sessionId: 'x', createEnv: { OASIS_NEURON_LEDGER_FILE: off, OASIS_NEURON_LEDGER: '0' } }, { type: 'explore' });
  assert.equal(existsSync(off), false);
});

test('a ledger write adds well under 5 ms per spawn', async (t) => {
  const dir = await tempDir(t);
  const session = sessionFor(path.join(dir, 'perf.sqlite'), 'perf');
  registerAgent(session, { type: 'warm-up' });
  const times = [];
  for (let i = 0; i < 200; i++) {
    const started = process.hrtime.bigint();
    registerAgent(session, { type: 'explore', description: 'worker ' + i });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  assert.ok(median < 5, 'median spawn with ledger write took ' + median.toFixed(3) + ' ms');
});
