import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startOasisWebServer } from '../src/web.mjs';
import { hostScheduler, runningDaemonPid, createJob, schedulesDirectory } from '../src/routines.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

test('web /api/routines lists, creates and manages routines for the signed-in owner only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rw-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789', refreshModelCatalog: false });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port + '/api/routines';
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { method: 'POST', body: '{}' })).status, 401);
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const post = async (body) => { const r = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const empty = await (await fetch(base, { headers })).json();
  assert.deepEqual(empty.routines, []);
  assert.equal(empty.scheduler, 'stopped');
  const created = await post({ action: 'create', fields: { name: 'nightly', schedule: '0 2 * * *', prompt: 'run the tests' } });
  assert.equal(created.status, 200);
  assert.equal(created.body.routines.length, 1);
  const job = created.body.routines[0];
  assert.equal(job.name, 'nightly');
  assert.equal(job.workdir, root);
  assert.equal(job.state, 'scheduled');
  assert.equal((await post({ action: 'pause', id: 'nightly' })).body.routines[0].enabled, false);
  assert.equal((await post({ action: 'resume', id: job.id })).body.routines[0].enabled, true);
  const bad = await post({ action: 'create', fields: { schedule: 'whenever', prompt: 'x' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /schedule/i);
  assert.equal((await post({ action: 'explode', id: job.id })).status, 400);
  assert.deepEqual((await post({ action: 'remove', id: job.id })).body.routines, []);
});

test('hostScheduler runs routines in-process once per config folder and can be turned off', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_SCHEDULED_RUN: '', OASIS_ROUTINES: '' };
  assert.equal((await hostScheduler({ env: { ...env, OASIS_ROUTINES: 'off' } })).hosted, false);
  await createJob({ schedule: 'every 1h', prompt: 'x' }, { env });
  const first = await hostScheduler({ env, intervalMs: 60_000 });
  assert.equal(first.hosted, true);
  assert.equal(first.routines, 1);
  // Same process owns the pid file; a different live pid blocks a second host.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(String(process.pid), (await readFile(path.join(schedulesDirectory(env), 'daemon.pid'), 'utf8')).trim());
  await first.stop();
  await mkdir(schedulesDirectory(env), { recursive: true });
  await writeFile(path.join(schedulesDirectory(env), 'daemon.pid'), String(process.ppid) + '\n');
  assert.equal(await runningDaemonPid(env), process.ppid);
  const second = await hostScheduler({ env });
  assert.equal(second.hosted, false);
  assert.match(second.reason, /another scheduler/);
  await writeFile(path.join(schedulesDirectory(env), 'daemon.pid'), '999999999\n');
  assert.equal(await runningDaemonPid(env), 0, 'a stale pid does not block');
});

test('the browser workspace has a Routines section wired to /api/routines', async () => {
  const html = await readFile(path.join(APP, 'index.html'), 'utf8');
  const js = await readFile(path.join(APP, 'main.mjs'), 'utf8');
  for (const id of ['routineSettings', 'routineList', 'routineAddButton', 'routineSchedule', 'routinePrompt', 'routineScript', 'routineDeliver', 'routineName', 'routineStatus', 'routineScheduler', 'routineAdd']) assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.match(js, /\/api\/routines/);
});
