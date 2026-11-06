import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHardQuotaError, shortRateLimitMs } from '../src/agent.mjs';

// Pollinations' keyless endpoint, as seen live on 2026-11-06.
const pollinations = (seconds) => JSON.stringify({ status: 402, success: false, error: { code: 'FREE_LIMIT', message: 'Free limit reached: 1 reply every 45 seconds per IP. Retry after ' + seconds + 's, or get unlimited replies with a pollen key at https://enter.pollinations.ai/?ref=classic' } });

test('an explicit short "retry after Ns" hint is a short wait; long or billing limits are not', () => {
  assert.equal(shortRateLimitMs(pollinations(43)), 43500);
  assert.equal(isHardQuotaError(pollinations(43)), false);
  assert.equal(shortRateLimitMs('Rate limited. Retry in 12 seconds.'), 12500);
  assert.equal(shortRateLimitMs(pollinations(600)), null, 'over 90 s is not a short wait');
  assert.equal(shortRateLimitMs('Insufficient credits. Retry after 30s'), null);
  assert.equal(shortRateLimitMs('Daily limit reached. Retry after 30s'), null);
  assert.equal(shortRateLimitMs('This request requires more credits, or fewer max_tokens.'), null);
});

async function runAgainst(t, firstStatus, firstBody) {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-esw-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    if (requests === 1) { res.writeHead(firstStatus, { 'content-type': 'application/json' }); res.end(firstBody); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'finished after the wait' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, '-p', 'hello'], { cwd: home, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_NO_STREAM: '1', OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'fixture' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 40000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
  return { ...result, requests, ms: Date.now() - started };
}

test('a 402 that says "retry after 1s" is waited out and the run finishes', async (t) => {
  const run = await runAgainst(t, 402, pollinations(1));
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /finished after the wait/);
  assert.equal(run.requests, 2);
  assert.ok(run.ms >= 1400, 'waited for the hinted time');
});

test('a real billing 402 still fails fast without a retry', async (t) => {
  const run = await runAgainst(t, 402, JSON.stringify({ error: { message: 'Insufficient credits. Add more at https://example.test/billing' } }));
  assert.notEqual(run.code, 0);
  assert.equal(run.requests, 1);
  assert.match(run.out, /402|credits/i);
});
