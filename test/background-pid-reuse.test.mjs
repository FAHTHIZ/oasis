import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { processStartTicks, sameProcess, readEntry, stopBackgroundSession, startExecJob, currentBootId } from '../src/background-sessions.mjs';

const linux = process.platform === 'linux';

test('processStartTicks reads field 22 of /proc/PID/stat, even when the command name has spaces and parentheses', () => {
  const fields = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), '987654', '0'];
  const stat = '4242 (my (odd) name) ' + fields.join(' ');
  assert.equal(processStartTicks(4242, { readStat: () => stat }), 987654);
  assert.equal(processStartTicks(4242, { readStat: () => { throw new Error('gone'); } }), null);
  assert.equal(processStartTicks(0), null);
  assert.equal(processStartTicks(-5), null);
});

test('sameProcess rejects a live PID whose start time differs (the PID was reused)', () => {
  const live = () => true;
  assert.equal(sameProcess({ pid: 10, procStart: 500 }, { isAlive: live, startTicks: () => 500 }), true);
  assert.equal(sameProcess({ pid: 10, procStart: 500 }, { isAlive: live, startTicks: () => 9000 }), false, 'reused PID');
  assert.equal(sameProcess({ pid: 10, procStart: 500 }, { isAlive: () => false, startTicks: () => 500 }), false);
  assert.equal(sameProcess({ pid: 10 }, { isAlive: live, startTicks: () => 1 }), true, 'old entries fall back to a PID check');
});

test('a running entry whose PID now belongs to another process is reported interrupted and never signalled', { skip: !linux }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-pidreuse-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home };
  // A bystander in its own process group, standing in for an unrelated program that got the PID.
  const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-bystander.pid, 'SIGKILL'); } catch {} });
  await new Promise((resolve) => bystander.once('spawn', resolve));
  const realStart = processStartTicks(bystander.pid);
  assert.ok(Number.isFinite(realStart));
  const dir = path.join(home, 'background');
  await mkdir(dir, { recursive: true });
  const entry = { id: 'bg-reuse0001', runId: 'r1', sessionId: 's1', root: home, prompt: 'task', status: 'running', startedAt: new Date().toISOString(), bootId: currentBootId(), logFile: path.join(dir, 'bg-reuse0001.log'), pid: bystander.pid, procStart: realStart - 1 };
  await writeFile(path.join(dir, entry.id + '.json'), JSON.stringify(entry));
  assert.equal((await readEntry(entry.id, env)).status, 'interrupted');
  const result = await stopBackgroundSession(entry.id, env);
  assert.equal(result.stopped, false);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(bystander.exitCode, null, 'the unrelated process group was not signalled');
  assert.equal(bystander.signalCode, null);
});

test('exec jobs record their start time and can still be stopped', { skip: !linux }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-pidstart-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home };
  const entry = await startExecJob({ root: home, command: 'sleep 30', env });
  assert.ok(Number.isFinite(entry.procStart), 'start time recorded');
  const saved = JSON.parse(await readFile(path.join(home, 'background', entry.id + '.json'), 'utf8'));
  assert.equal(saved.procStart, entry.procStart);
  assert.equal((await readEntry(entry.id, env)).status, 'running');
  const stopped = await stopBackgroundSession(entry.id, env);
  assert.equal(stopped.stopped, true);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && processStartTicks(entry.pid) !== null) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processStartTicks(entry.pid), null, 'the job is gone');
});
