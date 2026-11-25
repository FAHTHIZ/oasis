// Unattended routines: repeated failures pause the routine instead of failing
// (and alerting) forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createJob, listRuns, readJobs, resumeJob, tick, maxRoutineFailures } from '../src/routines.mjs';

async function tempEnv(extra = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rtr-'));
  return { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_SCHEDULED_RUN: '', OASIS_BASE_URL: '', OASIS_MODEL: '', OASIS_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OASIS_ROUTINE_MAX_FAILURES: '', ...extra };
}

// Fake background runner: each launch ends as soon as the test calls finish().
function fakeBackgrounds(dir) {
  const entries = new Map();
  let n = 0;
  const start = (kind) => async (options) => {
    const id = 'bg-fake' + String(++n).padStart(4, '0');
    entries.set(id, { id, status: 'running', kind, options, logFile: null });
    return entries.get(id);
  };
  return {
    entries,
    async finish(exitCode, text) {
      for (const entry of entries.values()) {
        if (entry.status !== 'running') continue;
        entry.logFile = path.join(dir, entry.id + '.log');
        await writeFile(entry.logFile, text + '\n[exit ' + exitCode + ']\n');
        Object.assign(entry, { status: 'exited', exitCode });
      }
    },
    startBackgroundSession: start('agent'),
    startExecJob: start('exec'),
    readEntry: async (id) => { if (!entries.has(id)) throw new Error('gone'); return entries.get(id); },
    stopBackgroundSession: async (id) => { entries.get(id).status = 'stopped'; }
  };
}

test('three failed runs in a row pause the routine and say how to resume', async () => {
  const env = await tempEnv();
  const bg = fakeBackgrounds(env.HOME);
  let now = new Date('2026-11-11T10:00:00Z');
  await createJob({ schedule: 'every 1h', prompt: 'false', kind: 'script', name: 'flaky', deliver: 'local' }, { env, now });
  for (let i = 1; i <= 3; i++) {
    now = new Date(now.getTime() + 3_600_000);
    assert.equal((await tick({ env, now, backgrounds: bg })).fired.length, 1, 'run ' + i + ' fires');
    await bg.finish(1, 'boom ' + i);
    now = new Date(now.getTime() + 60_000);
    await tick({ env, now, backgrounds: bg });
  }
  const [job] = await readJobs(env);
  assert.equal(job.enabled, false);
  assert.equal(job.state, 'paused');
  assert.match(job.pausedReason, /3 failed runs in a row/);
  const { runs } = await listRuns('flaky', { env });
  assert.deepEqual(runs.map((run) => run.status), ['failed', 'failed', 'failed']);
  // Paused: the next slot does not fire.
  assert.equal((await tick({ env, now: new Date(now.getTime() + 3_600_000), backgrounds: bg })).fired.length, 0);
  const resumed = await resumeJob('flaky', { env, now });
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.failureStreak, undefined, 'resume starts a fresh streak');
});

test('a success resets the streak, and OASIS_ROUTINE_MAX_FAILURES=0 never pauses', async () => {
  assert.equal(maxRoutineFailures({}), 3);
  assert.equal(maxRoutineFailures({ OASIS_ROUTINE_MAX_FAILURES: '0' }), 0);
  assert.equal(maxRoutineFailures({ OASIS_ROUTINE_MAX_FAILURES: 'x' }), 3);
  const env = await tempEnv({ OASIS_ROUTINE_MAX_FAILURES: '0' });
  const bg = fakeBackgrounds(env.HOME);
  let now = new Date('2026-11-11T10:00:00Z');
  await createJob({ schedule: 'every 1h', prompt: 'false', kind: 'script', name: 'never' }, { env, now });
  for (let i = 1; i <= 4; i++) {
    now = new Date(now.getTime() + 3_600_000);
    await tick({ env, now, backgrounds: bg });
    await bg.finish(1, 'boom');
    now = new Date(now.getTime() + 60_000);
    await tick({ env, now, backgrounds: bg });
  }
  const [job] = await readJobs(env);
  assert.equal(job.enabled, true);
  assert.equal(job.failureStreak, 4);
});
