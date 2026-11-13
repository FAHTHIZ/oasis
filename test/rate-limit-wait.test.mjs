import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitResetMs, rateLimitWaitMs } from '../src/agent.mjs';

const h = (o) => new Headers(o);
const now = Date.parse('2026-11-02T10:00:00Z');

test('reads reset times from Retry-After, Anthropic and OpenAI headers', () => {
  assert.equal(rateLimitResetMs(h({ 'retry-after': '120' }), now), 120000);
  assert.equal(rateLimitResetMs(h({ 'anthropic-ratelimit-tokens-reset': '2026-11-02T10:05:00Z' }), now), 300000);
  assert.equal(rateLimitResetMs(h({ 'x-ratelimit-reset-requests': '1m30s', 'x-ratelimit-reset-tokens': '250ms' }), now), 90000);
  assert.equal(rateLimitResetMs(h({ 'x-ratelimit-reset-tokens': 'soon' }), now), null);
  assert.equal(rateLimitResetMs(h({}), now), null);
});

test('waiting is opt-in, bounded, and never for billing errors', () => {
  const headers = h({ 'retry-after': '600' });
  assert.equal(rateLimitWaitMs({ status: 429, headers, now }), null, 'off by default');
  assert.equal(rateLimitWaitMs({ status: 429, headers, maxMinutes: 30, now }), 601000);
  assert.equal(rateLimitWaitMs({ status: 429, headers, maxMinutes: 5, now }), null, 'reset too far away');
  assert.equal(rateLimitWaitMs({ status: 503, headers, maxMinutes: 30, now }), null);
  assert.equal(rateLimitWaitMs({ status: 429, headers, body: '{"error":{"type":"insufficient_quota"}}', maxMinutes: 30, now }), null);
  assert.equal(rateLimitWaitMs({ status: 429, headers, body: 'Your credit balance is too low', maxMinutes: 30, now }), null);
  assert.equal(rateLimitWaitMs({ status: 429, headers, body: 'Usage limit reached, resets in 10 minutes', maxMinutes: 30, now }), 601000);
  assert.equal(rateLimitWaitMs({ status: 429, headers: h({}), maxMinutes: 30, now }), null, 'unknown reset');
});

test('a headless run waits for the reset and then finishes', async (t) => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rlw-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    if (requests <= 3) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'finished after reset' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const run = (extra) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, '-p', 'hello'], { cwd: home, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_NO_STREAM: '1', OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'fixture', ...extra } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 40000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
  const off = await run({});
  assert.notEqual(off.code, 0, off.out);
  assert.equal(requests, 3, 'default: only the normal bounded retries');
  requests = 0;
  const on = await run({ OASIS_WAIT_FOR_RATE_LIMIT_MINUTES: '5' });
  assert.match(on.out, /\[rate limit\] Waiting \d+s for the provider rate limit \(attempt 1, until \d\d:\d\d:\d\d\)\./, on.out);
  assert.doesNotMatch(on.out, /\d{4}-\d\d-\d\dT/, 'a local clock time, not an ISO timestamp');
  assert.match(on.out, /finished after reset/, on.out);
  assert.equal(requests, 4);
});
