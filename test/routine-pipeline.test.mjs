// "after NAME": a routine that runs when another one finishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createJob, editJob, listRuns, readJobs, tick } from '../src/routines.mjs';

async function tempEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-pipe-'));
  return { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_SCHEDULED_RUN: '', OASIS_BASE_URL: 'http://127.0.0.1:9/v1', OASIS_MODEL: 'm', OASIS_API_KEY: 'k', OASIS_ROUTINE_MAX_FAILURES: '' };
}

function fakeBackgrounds(dir) {
  const entries = new Map();
  let n = 0;
  const start = (kind) => async (options) => { const id = 'bg-p' + String(++n).padStart(6, '0'); entries.set(id, { id, status: 'running', kind, options, logFile: null }); return entries.get(id); };
  return {
    entries,
    async finish(exitCode, text) {
      for (const entry of entries.values()) {
        if (entry.status !== 'running') continue;
        entry.logFile = path.join(dir, entry.id + '.log');
        await writeFile(entry.logFile, text + '\n[exit ' + exitCode + ']\n');
        Object.assign(entry, { status: exitCode ? 'failed' : 'completed', exitCode });
      }
    },
    startBackgroundSession: start('agent'), startExecJob: start('exec'),
    readEntry: async (id) => entries.get(id), stopBackgroundSession: async (id) => { entries.get(id).status = 'stopped'; }
  };
}

test('a downstream routine runs with the upstream output; failures follow "failed"; loops are refused', async () => {
  const env = await tempEnv();
  const bg = fakeBackgrounds(env.HOME);
  const t0 = new Date('2026-11-11T10:00:00Z');
  await createJob({ schedule: 'every 1h', prompt: 'echo report', kind: 'script', name: 'collect' }, { env, now: t0 });
  const post = await createJob({ schedule: 'after collect', prompt: 'Post a summary of: {output}', name: 'post' }, { env, now: t0 });
  const alert = await createJob({ schedule: 'after collect failed', prompt: 'Alert: collect {status}', name: 'alert' }, { env, now: t0 });
  assert.equal(post.schedule.display, 'after collect');
  assert.equal(post.webhookSecret, undefined, 'no webhook for a pipeline step');
  await assert.rejects(createJob({ schedule: 'after nobody', prompt: 'x' }, { env, now: t0 }), /nobody/);
  await assert.rejects(editJob('collect', { schedule: 'after post' }, { env, now: t0 }), /loop/);

  await tick({ env, now: new Date('2026-11-11T11:00:00Z'), backgrounds: bg });
  await bg.finish(0, '3 new issues');
  const summary = await tick({ env, now: new Date('2026-11-11T11:01:00Z'), backgrounds: bg });
  assert.deepEqual(summary.fired, [post.id], 'only the "ok" follower fired');
  const agent = [...bg.entries.values()].find((entry) => entry.kind === 'agent');
  assert.match(agent.options.prompt, /Post a summary of: "3 new issues"/);
  assert.match(agent.options.prompt, /routine "collect" \(rt-[0-9a-f]{8}\) finished with status ok[\s\S]*<previous_routine_output>\n3 new issues\n<\/previous_routine_output>/);
  await bg.finish(0, '{"type":"result","subtype":"success","result":"Posted."}');
  await tick({ env, now: new Date('2026-11-11T11:02:00Z'), backgrounds: bg });

  await tick({ env, now: new Date('2026-11-11T12:00:00Z'), backgrounds: bg });
  await bg.finish(1, 'network down');
  const second = await tick({ env, now: new Date('2026-11-11T12:01:00Z'), backgrounds: bg });
  assert.deepEqual(second.fired, [alert.id]);
  assert.equal((await listRuns('post', { env })).runs.length, 1, 'post did not run after a failure');
  const jobs = await readJobs(env);
  assert.equal(jobs.find((job) => job.name === 'alert').activeRun.eventId.startsWith('ev-'), true);
});

test('--coalesce runs a burst of webhook events as one batch', async () => {
  const { receiveWebhook } = await import('../src/routines.mjs');
  const crypto = await import('node:crypto');
  const env = await tempEnv();
  const bg = fakeBackgrounds(env.HOME);
  const t0 = new Date('2026-11-11T10:00:00Z');
  const job = await createJob({ schedule: 'webhook', prompt: 'Review: {event}', name: 'review', coalesce: true }, { env, now: t0 });
  for (const n of [1, 2, 3]) {
    const body = Buffer.from(JSON.stringify({ n }));
    const sig = 'sha256=' + crypto.createHmac('sha256', job.webhookSecret).update(body).digest('hex');
    await receiveWebhook(job.id, body, { signature: sig, event: 'push', env, now: t0 });
  }
  const summary = await tick({ env, now: t0, backgrounds: bg });
  assert.deepEqual(summary.fired, [job.id]);
  const agent = [...bg.entries.values()][0];
  assert.match(agent.options.prompt, /Review: "3 events, oldest first: push"/);
  assert.match(agent.options.prompt, /started by a batch of webhook events[\s\S]*<webhook_payload>\n\[\{"n":1\},\{"n":2\},\{"n":3\}\]\n<\/webhook_payload>/);
  assert.equal((await readJobs(env))[0].pendingEvents, undefined);
});

test('"at startup" routines run once per boot of the computer', async () => {
  const { queueStartupRuns } = await import('../src/routines.mjs');
  const env = await tempEnv();
  const bg = fakeBackgrounds(env.HOME);
  const t0 = new Date('2026-11-11T10:00:00Z');
  const job = await createJob({ schedule: 'at startup', prompt: 'Check the disks.', name: 'boot' }, { env, now: t0 });
  assert.equal(job.schedule.display, 'at startup');
  assert.equal(job.webhookSecret, undefined);
  assert.deepEqual(await queueStartupRuns(env, t0, 30), [job.id]);
  const summary = await tick({ env, now: t0, backgrounds: bg });
  assert.deepEqual(summary.fired, [job.id]);
  assert.match([...bg.entries.values()][0].options.prompt, /Check the disks\.[\s\S]*first scheduler start since this computer booted/);
  await bg.finish(0, '{"type":"result","subtype":"success","result":"ok"}');
  await tick({ env, now: t0, backgrounds: bg });
  // The scheduler restarts an hour later without a reboot: nothing queued.
  assert.deepEqual(await queueStartupRuns(env, new Date('2026-11-11T11:00:00Z'), 3630), []);
  // After a reboot it runs again.
  assert.deepEqual(await queueStartupRuns(env, new Date('2026-11-12T09:00:00Z'), 40), [job.id]);
});
