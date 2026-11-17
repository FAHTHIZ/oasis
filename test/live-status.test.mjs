import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveStatus, modelRequest, waitingLabel, promptProgressText, thoughtMs, formatTokens, outputRate } from '../app/core/live-status.mjs';

test('formatTokens is short', () => {
  assert.equal(formatTokens(812), '812');
  assert.equal(formatTokens(5900), '5.9k');
  assert.equal(formatTokens(5000), '5k');
  assert.equal(formatTokens(250000), '250k');
});

test('a cloud model before its first token is thinking, then still waiting', () => {
  const request = modelRequest({ startedAt: 0, inputTokens: 8000, model: 'openai/gpt-5' });
  assert.equal(waitingLabel(request, 10_000), 'Thinking');
  assert.equal(waitingLabel(request, 50_000), 'Still waiting for gpt-5');
});

test('a local model with a long prompt is reading it', () => {
  const request = modelRequest({ startedAt: 0, inputTokens: 5900, local: true });
  assert.equal(waitingLabel(request, 5_000), 'Thinking');
  assert.equal(waitingLabel(request, 20_000), 'Reading the prompt');
  const status = liveStatus({ request, elapsedMs: 20_000 }, 20_000);
  assert.equal(status.label, 'Reading the prompt');
  assert.deepEqual(status.meta, ['20s', '5.9k tokens sent']);
});

test('prompt progress shows percent and time left, and moves between reports', () => {
  const p = { total: 6000, cache: 0, processed: 2000, time_ms: 40_000 };
  assert.equal(promptProgressText(p), '33% of 6k tokens · about 1m 20s left');
  assert.match(promptProgressText(p, 20_000), /^50% of 6k tokens · about 1m 00s left$/);
  assert.equal(promptProgressText({ total: 10, processed: 10 }), '');
  const request = modelRequest({ startedAt: 0, inputTokens: 6000, local: true });
  request.progress = p; request.progressAt = 40_000;
  assert.equal(liveStatus({ request }, 40_000).meta[0], '33% of 6k tokens · about 1m 20s left');
});

test('streamed output counts tokens, rate for local models, and quiet spells', () => {
  const request = modelRequest({ startedAt: 0, local: true });
  request.firstOutputAt = 1000; request.lastOutputAt = 11_000;
  const turn = { outChars: 4000, streamMs: 10_000 };
  assert.equal(outputRate(turn, 11_000), 100);
  let status = liveStatus({ label: 'Writing src/a.mjs', phase: 'draft', request, turn }, 12_000);
  assert.equal(status.label, 'Writing src/a.mjs');
  assert.deepEqual(status.meta, ['↓ 1k tokens', '100 tok/s']);
  status = liveStatus({ label: 'Responding', phase: 'responding', request, turn }, 40_000);
  assert.ok(status.meta.includes('no new output for 29s'));
  // A running tool is not the model going quiet.
  status = liveStatus({ label: 'Running npm test', phase: 'tool', request, turn }, 40_000);
  assert.ok(!status.meta.some((m) => m.startsWith('no new output')));
});

test('approval, reconnecting and rate limits win over the model phase', () => {
  const request = modelRequest({ startedAt: 0 });
  assert.equal(liveStatus({ phase: 'approval', request }, 1000).label, 'Waiting for you');
  assert.equal(liveStatus({ phase: 'reconnecting', request }, 1000).label, 'Reconnecting');
  const limited = liveStatus({ request, rateLimitUntil: 11_000 }, 1000);
  assert.equal(limited.label, 'Rate limited');
  assert.deepEqual(limited.meta, ['retrying in 10s']);
});

test('thought time leaves out a local model reading the prompt', () => {
  const local = modelRequest({ startedAt: 0, local: true });
  local.firstOutputAt = 120_000;
  assert.equal(thoughtMs(local, 130_000, 0), 10_000);
  const cloud = modelRequest({ startedAt: 0 });
  cloud.firstOutputAt = 20_000;
  assert.equal(thoughtMs(cloud, 30_000, 0), 30_000);
  assert.equal(thoughtMs(null, 5000, 1000), 4000);
});

test('a finished run sums what it did', async () => {
  const { runSummary } = await import('../app/core/live-status.mjs');
  assert.equal(runSummary([]), '');
  assert.equal(runSummary([
    { name: 'read_file', args: { path: 'a.mjs' }, ok: true },
    { name: 'read_file', args: { path: './a.mjs' }, ok: true },
    { name: 'grep', args: {}, ok: true },
    { name: 'edit_file', args: { path: 'a.mjs' }, ok: true, lines: { added: 3, removed: 1 } },
    { name: 'write_file', args: { path: 'b.mjs' }, ok: true, lines: { added: 10, removed: 0 } },
    { name: 'edit_file', args: { path: 'c.mjs' }, ok: false },
    { name: 'run_command', args: {}, ok: false, outcome: 'declined' },
    { name: 'run_command', args: {}, ok: true },
    { name: 'web_search', args: {}, ok: true },
    { name: 'read_file', args: {} }
  ]), 'Edited 2 files +13 −1 · read 1 file · 1 search · ran 1 command · 1 web lookup · 1 step failed');
});

test('a group whose steps all failed never claims the work was done', async () => {
  const { groupTitle } = await import('../app/core/timeline.mjs');
  assert.equal(groupTitle([
    { name: 'edit_file', args: { path: 'src/greet.mjs' }, ok: false },
    { name: 'edit_file', args: { path: 'src/index.js' }, ok: false },
    { name: 'edit_file', args: { path: 'src/index.js' }, ok: false }
  ]), "Couldn't edit 2 files");
  assert.equal(groupTitle([{ name: 'edit_file', args: { path: 'a.mjs' }, ok: false }, { name: 'edit_file', args: { path: 'b.mjs' }, ok: true }]), 'Edited b.mjs');
});
