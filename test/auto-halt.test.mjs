import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isHardQuotaError, stopFailureType } from '../src/agent.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('hard quota 429s are classified as billing, plain rate limits are not', () => {
  assert.ok(isHardQuotaError('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'));
  assert.ok(isHardQuotaError('Your account is on hold'));
  assert.ok(!isHardQuotaError('Rate limit reached for requests per minute'));
  assert.equal(stopFailureType(Object.assign(new Error('429 insufficient_quota'), { status: 429 })), 'billing_error');
  assert.equal(stopFailureType(Object.assign(new Error('429 rate limit'), { status: 429 })), 'rate_limit');
});

test('a quota error is not retried and stops a /loop instead of firing again', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-halt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const child = spawn('script', ['-qfec', JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli), '/dev/null'], { cwd: home, env: { ...process.env, OASIS_SIMPLE_INPUT: '1', OASIS_NO_STREAM: '1', OASIS_DISABLE_THEME_RELOAD: '1', HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'fixture', OASIS_LOOP_DELAY_SCALE: '0.001' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.write('/loop 1m x5 check the deploy\n');
  const timer = setTimeout(() => child.kill(), 30000);
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (out.includes('[loop] Stopped.')) { clearInterval(iv); child.stdin.end('/exit\n'); resolve(); } }, 50);
    child.on('exit', () => { clearInterval(iv); resolve(); });
  });
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.on('exit', resolve));
  clearTimeout(timer);
  assert.match(out, /\[auto\] Paused loops/, out);
  assert.match(out, /\[loop\] Stopping: the last run hit a billing\/quota error/, out);
  assert.doesNotMatch(out, /Run 2 of 5/, out);
  assert.equal(requests, 1, 'no retries for a hard quota error');
});
