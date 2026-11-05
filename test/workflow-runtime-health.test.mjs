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
  assert.match(report, /Workflow runtime: available \(QuickJS\)/);
  assert.match(report, /Command isolation: not active; approval controls are not OS isolation/);
});

test('oasis doctor shows the workflow runtime, and --version never loads QuickJS', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-doctor-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_API_KEY: '', OASIS_BASE_URL: '', OASIS_MODEL: '' };
  const doctor = spawnSync(process.execPath, [cli, 'doctor'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  assert.match(doctor.stdout, /Workflow runtime: available \(QuickJS/);
  const hook = path.join(root, 'watch-quickjs.mjs');
  await writeFile(hook, "import { registerHooks } from 'node:module';\nregisterHooks({ resolve(specifier, context, next) { if (specifier.includes('quickjs')) process.stderr.write('LOADED ' + specifier + '\\n'); return next(specifier, context); } });\n");
  const version = spawnSync(process.execPath, ['--import', hook, cli, '--version'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(version.status, 0, version.stderr);
  assert.doesNotMatch(version.stderr, /LOADED/);
  const check = spawnSync(process.execPath, ['--import', hook, cli, 'doctor'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  assert.match(check.stderr, /LOADED quickjs-emscripten/, 'the hook does see QuickJS when doctor loads it');
});
