import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { describeWait, promptProgressText, waitLabel } from '../src/activity-indicator.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

async function llamaLikeServer(t) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [], prompt_progress: { total: 4000, cache: 0, processed: 2048, time_ms: 4000 } }));
    res.write(sse({ choices: [], prompt_progress: { total: 4000, cache: 0, processed: 4000, time_ms: 8000 } }));
    res.write(sse({ choices: [{ delta: { content: 'Done.' } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4000, completion_tokens: 2, total_tokens: 4002 } }));
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 2 }, bodies };
}

async function session(t, config, localContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-progress-'));
  const value = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  if (localContext) value.localContext = localContext;
  t.after(async () => { closeSession(value); await rm(root, { recursive: true, force: true }); });
  return value;
}

test('llama.cpp prompt_progress events reach the wait hook', async (t) => {
  const server = await llamaLikeServer(t);
  const events = [];
  const s = await session(t, server.config, { server: 'llama.cpp', contextTokens: 16384 });
  const result = await runAgentTurn(s, 'hi', { onDelta: () => {}, onModelWait: (event) => events.push(event) });
  assert.equal(result.text, 'Done.');
  assert.equal(server.bodies[0].return_progress, true);
  const progress = events.filter((event) => event.phase === 'progress');
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0].promptProgress, { total: 4000, cache: 0, processed: 2048, time_ms: 4000 });
  // The "tokens sent" estimate counts tool schemas, not just messages.
  const start = events.find((event) => event.phase === 'start');
  const bodyTokens = Math.ceil(JSON.stringify(server.bodies[0].tools || []).length / 4);
  assert.ok(start.inputTokens > bodyTokens, start.inputTokens + ' should exceed tool schema tokens ' + bodyTokens);
});

test('return_progress is only requested from a server identified as llama.cpp', async (t) => {
  const server = await llamaLikeServer(t);
  const s = await session(t, server.config, { server: 'ollama', contextTokens: 8192 });
  await runAgentTurn(s, 'hi', { onDelta: () => {}, onModelWait: () => {} });
  assert.equal('return_progress' in server.bodies[0], false);
  const plain = await session(t, server.config, null);
  await runAgentTurn(plain, 'hi', { onDelta: () => {}, onModelWait: () => {} });
  assert.equal('return_progress' in server.bodies[1], false);
});

test('progress text shows percent and an estimate from the measured rate', () => {
  assert.equal(promptProgressText({ total: 4000, cache: 0, processed: 2048, time_ms: 4000 }), '51% of 4k tokens · about 3s left');
  assert.equal(promptProgressText({ total: 7731, cache: 0, processed: 1024, time_ms: 1000 }), '13% of 7.7k tokens');
  // Cached tokens are read instantly, so they do not count toward the rate.
  assert.equal(promptProgressText({ total: 8000, cache: 4000, processed: 6000, time_ms: 100000 }), '75% of 8k tokens · about 1m 40s left');
  assert.equal(promptProgressText({ total: 4000, processed: 4000, time_ms: 9000 }), '');
  assert.equal(promptProgressText(null), '');
});

test('the wait line switches from reading to thinking when the prompt is read', () => {
  const reading = { local: true, inputTokens: 4000, promptProgress: { total: 4000, cache: 0, processed: 1000, time_ms: 3000 } };
  assert.equal(waitLabel(reading, 1000), 'Local model is reading the prompt');
  assert.match(describeWait(reading, 61000), /^Local model is reading the prompt… · 1m 01s · 25% of 4k tokens · about 9s left · esc to stop$/);
  const read = { ...reading, promptProgress: { total: 4000, cache: 0, processed: 4000, time_ms: 12000 } };
  assert.equal(waitLabel(read, 1000), 'Thinking');
  assert.match(describeWait(read, 1000), /4k tokens sent/);
});

test('between llama-server reports the line moves on at the measured rate', () => {
  const report = { total: 3725, cache: 0, processed: 2048, time_ms: 79165 };
  assert.equal(promptProgressText(report), '54% of 3.7k tokens · about 1m 04s left');
  assert.equal(promptProgressText(report, 30000), '75% of 3.7k tokens · about 34s left');
  // Never reaches 100% or zero time before the server says the read is done.
  assert.equal(promptProgressText(report, 600000), '99% of 3.7k tokens · about 1s left');
  // Without a measured rate there is nothing to extrapolate.
  assert.equal(promptProgressText({ total: 3725, cache: 0, processed: 0, time_ms: 0 }, 30000), '0% of 3.7k tokens');
});

test('the indicator extrapolates from the time of the last report', async () => {
  const { createActivityIndicator } = await import('../src/activity-indicator.mjs');
  let clock = 0;
  let written = '';
  let tick = null;
  const stream = { isTTY: true, columns: 200, write: (text) => { written = text; } };
  const timers = { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {} };
  const indicator = createActivityIndicator({ stream, env: { OASIS_MOTION: 'lite' }, color: false, now: () => clock, timers });
  indicator.start({ step: 1, local: true, inputTokens: 3725 });
  clock = 80000;
  indicator.update({ promptProgress: { total: 3725, cache: 0, processed: 2048, time_ms: 79165 } });
  tick();
  assert.match(written, /54% of 3\.7k tokens · about 1m 04s left/);
  clock = 110000;
  tick();
  assert.match(written, /Local model is reading the prompt… · 1m 50s · 75% of 3\.7k tokens · about 34s left/);
  indicator.stop();
});
