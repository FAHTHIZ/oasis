import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workflowRuntimeStatus } from '../src/workflow-sandbox.mjs';
import { workspaceDoctor } from '../src/doctor.mjs';

test('workflow runtime health probe reports an initialized QuickJS runtime', async () => {
  const status = await workflowRuntimeStatus();
  assert.equal(status.available, true);
  assert.equal(status.runtime, 'QuickJS');
});

test('workflow runtime health probe reports missing or broken runtimes without throwing', async () => {
  const status = await workflowRuntimeStatus({ loadRuntime: async () => { throw new Error('fixture runtime failure'); } });
  assert.equal(status.available, false);
  assert.equal(status.runtime, 'QuickJS');
  assert.match(status.reason, /fixture runtime failure/);
});

test('workspace doctor includes workflow runtime availability', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-workflow-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await workspaceDoctor(root, { env: { ...process.env, OASIS_CONFIG_DIR: path.join(root, '.config') } });
  assert.match(report, /Workflow runtime: available \\(QuickJS\\)/);
});
