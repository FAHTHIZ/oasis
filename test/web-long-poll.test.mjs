import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// GET /api/jobs/:id?after=N&wait=ms holds the request until the next event,
// so a page following a task sees it at once instead of polling.
test('job long poll: waits for the next event, returns at once when one is ready, and gives up after wait', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-longpoll-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
  const saved = { OASIS_CONFIG_DIR: process.env.OASIS_CONFIG_DIR, HOME: process.env.HOME };
  Object.assign(process.env, { OASIS_CONFIG_DIR: env.OASIS_CONFIG_DIR, HOME: root });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await setWorkspaceTrust(root, true, env);
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'node -e "console.log(6*7)"' }), { content: 'done' }]);
  await saveConfig(config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const started = await (await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'run it', mode: 'ask' }) })).json();
  assert.match(started.jobId, /^[0-9a-f-]{36}$/);
  const url = (after, wait) => base + '/api/jobs/' + started.jobId + '?after=' + after + (wait ? '&wait=' + wait : '');

  // From the start, a long poll returns as soon as there is an event.
  let snapshot = await (await fetch(url(0, 20_000), { headers })).json();
  assert.ok(snapshot.events.length > 0);
  let approval;
  let after = 0;
  for (let i = 0; i < 200 && !approval; i++) {
    for (const event of snapshot.events) { after = Math.max(after, event.id); if (event.type === 'approval_required') approval = event; }
    if (!approval) snapshot = await (await fetch(url(after, 20_000), { headers })).json();
  }
  assert.ok(approval, 'the command asks for approval');

  // Nothing new: wait= holds the request, then returns empty.
  let begun = Date.now();
  snapshot = await (await fetch(url(after, 300), { headers })).json();
  assert.equal(snapshot.events.length, 0);
  assert.ok(Date.now() - begun >= 250, 'the server held the request');

  // Answering the approval wakes a waiting reader straight away.
  begun = Date.now();
  const waiting = fetch(url(after, 20_000), { headers }).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fetch(base + '/api/jobs/' + started.jobId + '/approval', { method: 'POST', headers, body: JSON.stringify({ approvalId: approval.data.approvalId, approved: true }) });
  snapshot = await waiting;
  assert.ok(snapshot.events.length > 0);
  assert.ok(Date.now() - begun < 10_000, 'woken by the event, not the timeout');

  // Follow to the end; a finished task never holds a request.
  for (let i = 0; i < 200 && !['completed', 'error'].includes(snapshot.status); i++) {
    for (const event of snapshot.events) after = Math.max(after, event.id);
    snapshot = await (await fetch(url(after, 20_000), { headers })).json();
  }
  assert.equal(snapshot.status, 'completed');
  begun = Date.now();
  snapshot = await (await fetch(url(Number.MAX_SAFE_INTEGER, 20_000), { headers })).json();
  assert.ok(Date.now() - begun < 2000);
});

test('a session that is not saved yet is 404, not a server error', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-session404-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const response = await fetch('http://127.0.0.1:' + app.port + '/api/sessions/0f1e2d3c-4b5a-4968-8776-655443322110', { headers: { authorization: 'Bearer ' + app.token } });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /not saved yet or no longer exists/);
});
