// A webhook or "oasis schedule run" starts the routine now, not on the next pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createJob, readJobs, runDaemon, triggerJob } from '../src/routines.mjs';

const OASIS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'oasis.mjs');

async function tempEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-wake-'));
  return { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_SCHEDULED_RUN: '' };
}

async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return false;
}

const started = async (env) => { const [job] = await readJobs(env); return Boolean(job.activeRun || job.lastRunAt); };

test('a triggered run starts within moments in an in-process scheduler', async () => {
  const env = await tempEnv();
  await createJob({ schedule: 'every 1h', prompt: 'true', kind: 'script', name: 'now' }, { env });
  const controller = new AbortController();
  const daemon = runDaemon({ env, intervalMs: 600_000, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await triggerJob('now', { env });
  assert.ok(await waitFor(() => started(env), 3000), 'started without waiting for the 10-minute pass');
  controller.abort();
  await daemon;
});

test('a triggered run wakes a scheduler in another process', async () => {
  const env = await tempEnv();
  await createJob({ schedule: 'every 1h', prompt: 'true', kind: 'script', name: 'remote' }, { env });
  const child = spawn(process.execPath, [OASIS, 'schedule', 'daemon', '--interval', '600'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    assert.ok(await waitFor(() => out.includes('Routine daemon started')), 'daemon started');
    await triggerJob('remote', { env });
    assert.ok(await waitFor(() => started(env), 5000), 'the other process picked it up');
  } finally { child.kill('SIGTERM'); }
});
