import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startOasisWebServer } from '../src/web.mjs';
import { createCloudTaskStore } from '../src/cloud-task-store.mjs';

test('task history API authenticates requests and exposes recovered task state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cloud-task-api-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const workspace = path.join(root, 'workspace');
  const store = createCloudTaskStore(workspace, { env });
  const completedId = randomUUID();
  const interruptedId = randomUUID();
  const timestamp = new Date().toISOString();

  await store.save({
    id: completedId,
    type: 'agent',
    title: 'Completed implementation',
    status: 'completed',
    sessionId: randomUUID(),
    workspaceName: 'demo',
    createdAt: timestamp,
    events: [{ id: 1, type: 'completed', at: timestamp, data: { summary: 'verified result' } }],
    nextEventId: 2,
    result: { text: 'done' },
    error: null
  });
  await store.save({
    id: interruptedId,
    type: 'agent',
    title: 'In progress before restart',
    status: 'running',
    sessionId: randomUUID(),
    workspaceName: 'demo',
    createdAt: timestamp,
    events: [{ id: 1, type: 'started', at: timestamp, data: { sessionId: randomUUID() } }],
    nextEventId: 2,
    result: null,
    error: null
  });

  const app = await startOasisWebServer({
    root: workspace,
    host: '127.0.0.1',
    port: 0,
    env,
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const anonymous = await fetch(base + '/api/jobs');
  assert.equal(anonymous.status, 401);

  const headers = { authorization: 'Bearer ' + app.token };
  const listed = await fetch(base + '/api/jobs', { headers });
  assert.equal(listed.status, 200);
  const tasks = (await listed.json()).tasks;
  assert.equal(tasks.find((task) => task.id === completedId).status, 'completed');
  assert.equal(tasks.find((task) => task.id === interruptedId).status, 'interrupted');

  const details = await fetch(base + '/api/jobs/' + interruptedId, { headers });
  assert.equal(details.status, 200);
  const task = await details.json();
  assert.equal(task.status, 'interrupted');
  assert.equal(task.events.at(-1).type, 'interrupted');
  assert.match(task.error, /runtime restarted/i);
});
