import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const powerTools = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'power-tools.mjs')).href;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function launch(t, mode, extraEnv = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-bgexit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'run.mjs');
  // Importing power-tools.mjs first also guards against the old circular-import crash.
  await writeFile(script, [
    "import { executePowerTool } from " + JSON.stringify(powerTools) + ";",
    "const ctx = { root: " + JSON.stringify(dir) + ", autoApprove: true, approval: async () => true, env: process.env, session: {} };",
    "const started = await executePowerTool('run_shell', { command: 'sleep 300', run_in_background: true }, ctx, " + JSON.stringify(dir) + ");",
    "console.log(started.pid);",
    mode === 'term' ? "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);" : "process.exit(0);"
  ].join('\n'));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 20000 });
  const pid = Number(result.stdout.trim());
  assert.ok(pid > 0, result.stderr);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { pid, status: result.status };
}

test('background commands are stopped when OASIS exits', { skip: process.platform === 'win32' }, async (t) => {
  const { pid } = await launch(t, 'exit');
  assert.equal(alive(pid), false);
});

test('background commands are stopped on SIGTERM and the exit code is 143', { skip: process.platform === 'win32' }, async (t) => {
  const { pid, status } = await launch(t, 'term');
  assert.equal(status, 143);
  assert.equal(alive(pid), false);
});

test('OASIS_KEEP_BACKGROUND_ON_EXIT=1 keeps them running', { skip: process.platform === 'win32' }, async (t) => {
  const { pid } = await launch(t, 'exit', { OASIS_KEEP_BACKGROUND_ON_EXIT: '1' });
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} });
  assert.equal(alive(pid), true);
});
