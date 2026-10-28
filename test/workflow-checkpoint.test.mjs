import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, closeSession } from '../src/agent.mjs';
import { saveSession, loadSession } from '../src/sessions.mjs';
import { agentRegistry, agentEvents } from '../src/agent-tasks.mjs';

const settings = {
  permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' },
  hooks: {},
  sandbox: { enabled: false },
  shell: { enabled: false },
  autoMemory: false
};

test('saved active task workflows restore as paused recovery checkpoints, never as live workers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-workflow-checkpoint-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-workflow-checkpoint-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_AUTO_MEMORY: '0' };
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'test-model' };
  const original = await createSession({ root, config, settings, env });
  t.after(() => closeSession(original));
  original.messages.push({ role: 'user', content: 'Implement the project workflow.' });
  agentRegistry(original).autoDispatch = {
    enabled: true,
    maxParallel: 2,
    teamId: null,
    dispatching: false,
    pending: false,
    options: { secret: 'must not be serialized' }
  };

  const saved = await saveSession(original, { env });
  const restored = await loadSession(root, saved.id, { env });
  assert.equal(restored.workflowCheckpoint.active, true);
  assert.equal(restored.workflowCheckpoint.maxParallel, 2);
  assert.equal(restored.workflowCheckpoint.teamId, null);
  assert.ok(Number.isFinite(Date.parse(restored.workflowCheckpoint.savedAt)));
  assert.ok(!JSON.stringify(restored).includes('must not be serialized'));

  const resumed = await createSession({ root, config, settings, env, restore: restored });
  t.after(() => closeSession(resumed));
  assert.equal(resumed.agentTasks.autoDispatch, undefined, 'background dispatch must not restart after process restart');
  assert.equal(resumed.agentTasks.autoDispatchCheckpoint.status, 'interrupted');
  assert.equal(resumed.agentTasks.autoDispatchCheckpoint.maxParallel, 2);
  assert.match(resumed.messages[0].content, /workflow is paused, not running/);
  assert.ok(agentEvents(resumed, { limit: 20 }).events.some((event) => event.type === 'task.auto_dispatch_interrupted'));
});
