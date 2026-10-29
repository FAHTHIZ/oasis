import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { scheduleWakeup } from '../src/session-tools.mjs';
import { parseLoopArgs } from '../src/slash.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('schedule_wakeup validates and clamps, and only works in a self-paced loop', () => {
  assert.throws(() => scheduleWakeup({}, { delay_seconds: 120, reason: 'x' }), /self-paced/);
  const session = { selfPacedLoop: true };
  assert.equal(scheduleWakeup(session, { delay_seconds: 5, reason: 'fast' }).delay_seconds, 60);
  assert.deepEqual(session.loopWakeup, { delayMs: 60000, reason: 'fast' });
  scheduleWakeup(session, { stop: true, reason: 'done' });
  assert.equal(session.loopWakeup.stop, true);
  assert.equal(parseLoopArgs('5m x2 hi').selfPaced, undefined);
});

test('/loop without an interval lets the model pace and stop the loop', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-loop-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [
    toolCall('w1', 'schedule_wakeup', { delay_seconds: 90, reason: 'CI takes a bit' }),
    { content: 'checked once' },
    toolCall('w2', 'schedule_wakeup', { stop: true, reason: 'deploy finished' }),
    { content: 'all done' }
  ]);
  // The REPL needs a terminal; script(1) provides one.
  const child = spawn('script', ['-qfec', JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli), '/dev/null'], { cwd: home, env: { ...process.env, OASIS_SIMPLE_INPUT: '1', OASIS_NO_STREAM: '1', OASIS_DISABLE_THEME_RELOAD: '1', HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_LOOP_DELAY_SCALE: '0.001' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.write('/loop check whether the deploy finished\n');
  const timer = setTimeout(() => child.kill(), 30000);
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (out.includes('[loop] Stopped.')) { clearInterval(iv); child.stdin.end('/exit\n'); resolve(); } }, 50);
    child.on('exit', () => { clearInterval(iv); resolve(); });
  });
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.on('exit', resolve));
  clearTimeout(timer);
  assert.match(out, /Self-paced/, out);
  assert.match(out, /Next run in 90s \(CI takes a bit\)/, out);
  assert.match(out, /The model ended the loop: deploy finished/, out);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'schedule_wakeup'));
  assert.match(JSON.stringify(requests[0].messages), /self-paced loop/);
  assert.equal(requests.length, 4);
});
