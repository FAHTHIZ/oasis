import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCloudTaskStore } from '../src/cloud-task-store.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cloud-tasks-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  return { root, env, workspace: path.join(root, 'workspace') };
}

test('cloud task history is private, durable, and redacts common credentials', async (t) => {
  const { root, env, workspace } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const id = randomUUID();
  const job = {
    id,
    status: 'running',
    type: 'agent',
    title: 'Check a provider',
    sessionId: randomUUID(),
    workspaceName: 'example',
    createdAt: new Date().toISOString(),
    events: [{
      id: 1,
      type: 'tool_result',
      at: new Date().toISOString(),
      data: {
        output: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
        apiKey: 'should-not-be-stored',
        note: 'github_pat_abcdefghijklmnopqrstuvwxyz0123456789'
      }
    }],
    nextEventId: 2,
    result: null,
    error: null
  };

  const store = createCloudTaskStore(workspace, { env });
  await store.save(job);

  const file = path.join(store.directory, id + '.json');
  const permissions = (await stat(file)).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(permissions, 0o600);

  const restarted = createCloudTaskStore(workspace, { env });
  const restored = await restarted.get(id);
  assert.equal(restored.status, 'interrupted');
  assert.match(restored.error, /runtime restarted/i);
  assert.match(restored.events.at(-1).type, /interrupted/i);
  assert.match(restored.events[0].data.output, /Bearer \[REDACTED\]/);
  assert.equal(restored.events[0].data.apiKey, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(restored), /should-not-be-stored|abcdefghijklmnopqrstuvwxyz0123456789/);
});

test('completed tasks remain completed across runtime restarts and appear in task summaries', async (t) => {
  const { root, env, workspace } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const id = randomUUID();
  const job = {
    id,
    status: 'completed',
    type: 'terminal',
    title: 'Run tests',
    sessionId: randomUUID(),
    workspaceName: 'project',
    createdAt: new Date().toISOString(),
    events: [{ id: 1, type: 'completed', at: new Date().toISOString(), data: { exitCode: 0 } }],
    nextEventId: 2,
    result: { exitCode: 0 },
    error: null
  };

  const store = createCloudTaskStore(workspace, { env });
  await store.save(job);
  const restarted = createCloudTaskStore(workspace, { env });
  const summary = (await restarted.list({ limit: 10 }))[0];
  assert.equal(summary.id, id);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.type, 'terminal');
  assert.equal(summary.title, 'Run tests');
  assert.equal(summary.eventCount, 1);
  assert.equal((await restarted.get(id)).result.exitCode, 0);
});

test('scheduled writes can be flushed before orderly shutdown', async (t) => {
  const { root, env, workspace } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const id = randomUUID();
  const job = {
    id, status: 'running', type: 'agent', title: 'Flush test',
    createdAt: new Date().toISOString(), events: [], nextEventId: 1,
    result: null, error: null
  };
  const store = createCloudTaskStore(workspace, { env });
  store.schedule(job, 2000);
  await store.flush([job]);
  assert.equal((await store.get(id)).status, 'running');
});
