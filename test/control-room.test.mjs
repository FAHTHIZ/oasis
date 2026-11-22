import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { summarizeLedger, ledgerActivity, liveActivity, formatControlRoom, controlRoomSnapshot } from '../src/control-room.mjs';
import { sharedNeuronLedger, closeNeuronLedgers } from '../src/neuron-ledger.mjs';
import { controlRoomKpis, controlRoomAgents, controlRoomEnvironments, controlRoomHistory, formatTokens, formatCost } from '../app/core/control-room.mjs';
import { startOasisWebServer } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const HOUR = 3600_000;

function rows(spec) {
  return spec.map(([neuron_id, kind, at, extra = {}]) => ({ neuron_id, kind, at, status: null, tokens: 0, cost_usd: 0, requests: 0, parent_id: 'main', depth: 1, role: 'explore', description: 'task ' + neuron_id, ...extra }));
}

test('the ledger summary counts the window, flags quiet agents and keeps lifecycle history', () => {
  const now = 100 * HOUR;
  const since = now - 24 * HOUR;
  const recent = [
    { sessionId: 'terminal-session', rows: rows([
      ['agent_1', 'spawn', now - 2 * HOUR],
      ['agent_1', 'charge', now - 2 * HOUR, { tokens: 1000, cost_usd: 0.01, requests: 1 }],
      ['agent_1', 'transition', now - HOUR, { status: 'completed' }],
      ['agent_2', 'spawn', now - 3 * HOUR],
      ['agent_2', 'charge', now - 2 * HOUR, { tokens: 500, requests: 1 }]
    ]) },
    { sessionId: 'web-session', rows: rows([
      ['agent_1', 'spawn', now - 40 * HOUR],
      ['agent_1', 'charge', now - 40 * HOUR, { tokens: 9999, requests: 1 }],
      ['agent_1', 'charge', now - 60_000, { tokens: 10, requests: 1 }]
    ]) }
  ];
  const summary = summarizeLedger(recent, { now, since, liveSessionIds: new Set(['web-session']) });
  assert.equal(summary.totals.agents, 3);
  assert.equal(summary.totals.completed, 1);
  // agent_2 in the terminal session has been silent for 2h: probably a killed process.
  assert.equal(summary.totals.quiet, 1);
  // The live web session's agent is running even though it started 40h ago; only its in-window charge counts.
  assert.equal(summary.totals.running, 1);
  assert.equal(summary.totals.tokens, 1000 + 500 + 10);
  assert.equal(summary.totals.costUsd, 0.01);
  assert.deepEqual(summary.agents.map((agent) => agent.sessionId + '/' + agent.id + ':' + agent.status), ['web-session/agent_1:running', 'terminal-session/agent_2:quiet', 'terminal-session/agent_1:completed']);
  assert.deepEqual(summary.history.map((item) => item.agentId + ' ' + item.event), ['agent_1 completed', 'agent_1 started', 'agent_2 started'], 'newest first, charges and out-of-window rows left out');
  assert.equal(summary.sessions.find((item) => item.id === 'web-session').live, true);
});

test('ledger activity reads every session in the shared file; off when the ledger is off', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-cr-ledger-'));
  t.after(async () => { closeNeuronLedgers(); await rm(dir, { recursive: true, force: true }); });
  const env = { OASIS_NEURON_LEDGER_FILE: path.join(dir, 'ledger.sqlite') };
  const ledger = sharedNeuronLedger(env);
  if (!ledger) { t.skip('node:sqlite is not available'); return; }
  const now = Date.now();
  ledger.append('s1', { kind: 'spawn', neuronId: 'agent_1', role: 'plan', description: 'plan the release', at: now - 1000 });
  ledger.append('s1', { kind: 'charge', neuronId: 'agent_1', tokens: 42, costUsd: 0.002, requests: 1, at: now - 900 });
  ledger.append('s2', { kind: 'spawn', neuronId: 'agent_1', role: 'explore', description: 'old work', at: now - 72 * HOUR });
  ledger.append('s2', { kind: 'transition', neuronId: 'agent_1', status: 'completed', at: now - 71 * HOUR });
  const activity = ledgerActivity({ env, now });
  assert.equal(activity.available, true);
  assert.deepEqual(activity.sessions.map((item) => item.id), ['s1'], 'a session idle for days is outside the 24h window');
  assert.equal(activity.agents[0].description, 'plan the release');
  assert.equal(activity.totals.tokens, 42);
  assert.equal(ledgerActivity({ env, now, hours: 96 }).sessions.length, 2);
  assert.equal(ledgerActivity({ env: { ...env, OASIS_NEURON_LEDGER: '0' } }).available, false);
  const text = formatControlRoom(controlRoomSnapshot({ env, now }), { now });
  assert.match(text, /Agents: 1 \(1 running/);
  assert.match(text, /plan the release/);
});

test('live activity lists agents and their own screens and browsers', () => {
  const child = { agentEnvironment: 'desktop', computerState: { virtual: { display: ':101', size: { width: 1280, height: 800 }, vnc: { address: 'localhost:5901' } } }, browserState: { tabs: [{}, {}] } };
  const session = {
    computerState: { virtual: { display: ':100', size: { width: 1440, height: 900 } } },
    agentTasks: { agents: new Map([['agent_1', { id: 'agent_1', parentId: 'main', depth: 1, type: 'general-purpose', description: 'test the signup page', status: 'running', runs: 1, toolCalls: 3, recentTools: ['browser'], startedAt: Date.now() - 5000, child }]]), teams: new Map(), events: [] }
  };
  const live = liveActivity([{ id: 'sess-1', title: 'Fix signup', session, running: true }]);
  assert.equal(live.agents.length, 1);
  assert.equal(live.agents[0].description, 'test the signup page');
  assert.equal(live.agents[0].environment.kind, 'desktop');
  assert.deepEqual(live.environments.map((item) => item.agentId + ':' + item.kind), ['main:virtual screen', 'agent_1:own desktop']);
  const own = live.environments[1];
  assert.equal(own.screen.display, ':101');
  assert.equal(own.screen.watch, 'VNC localhost:5901');
  assert.equal(own.browserTabs, 2);

  const snapshot = { updatedAt: new Date().toISOString(), summary: { agentsWorking: 1, agentsElsewhere: 2, waitingForYou: 0, environments: 2, tokens: 12345, costUsd: 0.5, hours: 24 }, live, ledger: { agents: [{ sessionId: 'sess-1', id: 'agent_1', status: 'running', role: 'general-purpose' }, { sessionId: 'term', id: 'agent_9', status: 'quiet', role: 'explore', description: 'old', lastActivity: Date.now() - 3 * HOUR }], history: [{ at: Date.now() - 1000, sessionId: 'sess-1', agentId: 'agent_1', description: 'test the signup page', event: 'started' }], sessions: [] }, resources: { memoryTotal: 8 * 1024 ** 3, memoryFree: 4 * 1024 ** 3, cpus: 4, loadAverage: [1, 1, 1] } };
  const kpis = controlRoomKpis(snapshot);
  assert.equal(kpis.find((kpi) => kpi.id === 'working').value, '3');
  assert.equal(kpis.find((kpi) => kpi.id === 'spend').value, '12k');
  assert.equal(kpis.find((kpi) => kpi.id === 'machine').value, '25% load');
  const agents = controlRoomAgents(snapshot);
  assert.deepEqual(agents.map((row) => row.key), ['live:sess-1:agent_1', 'ledger:term:agent_9'], 'a live agent is not listed twice');
  assert.equal(agents[0].stoppable, true);
  assert.equal(agents[1].stoppable, false);
  assert.match(agents[1].meta, /last activity 3h ago/);
  assert.match(controlRoomEnvironments(snapshot)[1].detail, /screen :101 \(1280x800\) · watch: VNC localhost:5901 · 2 browser tabs/);
  assert.equal(controlRoomHistory(snapshot)[0].text, 'test the signup page started');
  assert.equal(formatTokens(1_500_000), '1.5M');
  assert.equal(formatCost(0.004), '<$0.01');
});

test('the web control room shows a subagent and can only stop agents in its own sessions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cr-web-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root, OASIS_NEURON_LEDGER_FILE: path.join(root, 'ledger.sqlite') };
  const saved = { OASIS_CONFIG_DIR: process.env.OASIS_CONFIG_DIR, HOME: process.env.HOME };
  Object.assign(process.env, { OASIS_CONFIG_DIR: env.OASIS_CONFIG_DIR, HOME: root });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await setWorkspaceTrust(root, true, env);
  const { config } = await scriptedModel(t, [
    (payload) => payload.messages[0].content.includes('SUBAGENT MODE') ? { content: 'child done' } : payload.messages.some((m) => m.role === 'tool') ? { content: 'parent done' } : toolCall('t1', 'task', { description: 'survey the repo', prompt: 'look around', subagent_type: 'general-purpose' })
  ]);
  await saveConfig(config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); closeNeuronLedgers(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/api/control-room')).status, 401, 'the control room needs the token like every agent API');

  const started = await (await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'survey', mode: 'auto' }) })).json();
  let snapshot; let after = 0;
  for (let i = 0; i < 300; i++) {
    snapshot = await (await fetch(base + '/api/jobs/' + started.jobId + '?after=' + after + '&wait=2000', { headers })).json();
    if (['completed', 'error', 'failed'].includes(snapshot.status)) break;
    for (const event of snapshot.events || []) after = Math.max(after, event.id || 0);
  }
  assert.equal(snapshot.status, 'completed');

  const room = await (await fetch(base + '/api/control-room', { headers })).json();
  assert.ok(room.resources.cpus >= 1);
  assert.ok(room.runs.some((run) => run.id === started.jobId));
  const live = room.live.agents.find((agent) => agent.description === 'survey the repo');
  assert.ok(live, 'the subagent is listed from the live session');
  assert.equal(live.status, 'completed');
  if (room.ledger.available) assert.ok(room.ledger.agents.some((agent) => agent.description === 'survey the repo' && agent.status === 'completed'), 'and from the ledger');
  const text = JSON.stringify(room);
  assert.doesNotMatch(text, /look around|child done|parent done/, 'no prompts or output leave the server');

  const missing = await fetch(base + '/api/control-room/stop', { method: 'POST', headers, body: JSON.stringify({ sessionId: 'not-a-session', agentId: 'agent_1' }) });
  assert.equal(missing.status, 404);
  const done = await fetch(base + '/api/control-room/stop', { method: 'POST', headers, body: JSON.stringify({ sessionId: live.sessionId, agentId: live.id }) });
  assert.equal(done.status, 200, 'stopping a finished agent is harmless');
});

test('oasis control-room prints the shared ledger as text and JSON', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-cr-cli-'));
  t.after(async () => { closeNeuronLedgers(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'config'), HOME: dir, OASIS_NEURON_LEDGER_FILE: path.join(dir, 'ledger.sqlite') };
  const ledger = sharedNeuronLedger(env);
  if (!ledger) { t.skip('node:sqlite is not available'); return; }
  ledger.append('3f9c2a1b-0000-4000-8000-000000000000', { kind: 'spawn', neuronId: 'agent_1', role: 'explore', description: 'map the auth module', at: Date.now() - 1000 });
  closeNeuronLedgers();
  const { execFileSync } = await import('node:child_process');
  const cli = path.join(import.meta.dirname, '..', 'src', 'oasis.mjs');
  const textOut = execFileSync(process.execPath, [cli, 'control-room'], { env, cwd: dir, encoding: 'utf8' });
  assert.match(textOut, /OASIS control room/);
  assert.match(textOut, /map the auth module.*session 3f9c2a1b\]/);
  const json = JSON.parse(execFileSync(process.execPath, [cli, 'control-room', '--json', '--hours', '2'], { env, cwd: dir, encoding: 'utf8' }));
  assert.equal(json.ledger.agents[0].description, 'map the auth module');
  assert.ok(json.resources.cpus >= 1);
});
