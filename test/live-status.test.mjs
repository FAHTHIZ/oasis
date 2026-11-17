import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sideWork, liveStatus, modelRequest, waitingLabel, promptProgressText, thoughtMs, formatTokens, outputRate } from '../app/core/live-status.mjs';

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

test('reasoning headlines come from bold titles or headings', async () => {
  const { reasoningHeadline } = await import('../app/core/live-status.mjs');
  assert.equal(reasoningHeadline('**Inspecting the project**\n\nI should list files.\n\n**Planning the edit**\n\nThen'), 'Planning the edit');
  assert.equal(reasoningHeadline('## Checking tests\nmore'), 'Checking tests');
  assert.equal(reasoningHeadline('Just thinking about **bold** words inline.'), '');
  assert.equal(reasoningHeadline(''), '');
});

test('a silent model is shown as stalled', async () => {
  const { STALLED_AFTER_MS } = await import('../app/core/live-status.mjs');
  const cloud = modelRequest({ startedAt: 0, model: 'anthropic/claude-x' });
  const status = liveStatus({ request: cloud }, STALLED_AFTER_MS + 1000);
  assert.equal(status.label, 'No response from claude-x yet');
  assert.equal(status.stalled, true);
  // A local model reading a long prompt is working, not stalled.
  const local = modelRequest({ startedAt: 0, local: true, inputTokens: 9000 });
  assert.equal(liveStatus({ request: local }, STALLED_AFTER_MS + 1000).stalled, false);
  // Mid-reply silence.
  const mid = modelRequest({ startedAt: 0 });
  mid.firstOutputAt = 1000; mid.lastOutputAt = 2000;
  assert.equal(liveStatus({ label: 'Responding', phase: 'responding', request: mid }, 2000 + STALLED_AFTER_MS).stalled, true);
  assert.equal(liveStatus({ label: 'Running npm test', phase: 'tool', request: mid }, 2000 + STALLED_AFTER_MS).stalled, false);
});

test('a request that carries on a cut-off reply, or retries, says so', () => {
  const now = 100_000;
  const resumed = modelRequest({ startedAt: now - 2000, resumed: true });
  assert.equal(liveStatus({ phase: 'waiting', request: resumed }, now).label, 'Picking the thought back up');
  const limited = modelRequest({ startedAt: now - 1000 });
  limited.attempt = 1; limited.retryUntil = now + 12_000; limited.retryStatus = 429;
  const status = liveStatus({ phase: 'waiting', request: limited }, now);
  assert.equal(status.label, 'Rate limited');
  assert.ok(status.meta.includes('retrying in 12s'), status.meta.join('|'));
  limited.retryUntil = 0;
  const retrying = liveStatus({ phase: 'waiting', request: limited }, now);
  assert.equal(retrying.label, 'Retrying');
  assert.ok(retrying.meta.includes('attempt 2'));
});

test('side work names running agents, parked approvals and queued messages', () => {
  assert.deepEqual(sideWork({}), []);
  const workers = [{ status: 'running' }, { status: 'stopping' }, { status: 'completed', waitingApproval: true }];
  assert.deepEqual(sideWork({ workers, queued: 1 }), ['2 agents running', '1 waiting for approval', '1 message queued']);
  assert.deepEqual(sideWork({ workers: [{ status: 'running' }], queued: 3 }), ['1 agent running', '3 messages queued']);
});

test('compaction shows its own status: what it reads, then the summary tokens', () => {
  const now = 200_000;
  const start = liveStatus({ phase: 'thinking', compaction: { startedAt: now - 2000, beforeTokens: 48_000 }, elapsedMs: 60_000 }, now);
  assert.equal(start.label, 'Compacting the conversation');
  assert.deepEqual(start.meta, ['1m 00s', 'summarising 48k tokens']);
  const writing = liveStatus({ phase: 'thinking', compaction: { startedAt: now - 12_000, beforeTokens: 48_000, outChars: 4000 }, elapsedMs: 70_000 }, now);
  assert.ok(writing.meta.some((part) => /^↓ 1k tokens of summary$/.test(part)), writing.meta.join('|'));
  assert.ok(writing.meta.includes('compacting for 12s'));
  assert.equal(liveStatus({ phase: 'approval', compaction: { startedAt: now } }, now).label, 'Waiting for you');
});

test('a slow hook shows its own label and how long it has run', () => {
  const now = 50_000;
  const status = liveStatus({ phase: 'hook', label: 'Running Stop hook', hookStartedAt: now - 5000, request: modelRequest({ startedAt: now - 200_000 }) }, now);
  assert.equal(status.label, 'Running Stop hook');
  assert.ok(status.meta.includes('hook running for 5s'), status.meta.join('|'));
  assert.equal(status.stalled, false);
});

test('formatTokens switches to millions instead of showing "1000k"', () => {
  assert.equal(formatTokens(999499), '999k');
  assert.equal(formatTokens(999500), '1M');
  assert.equal(formatTokens(1000000), '1M');
  assert.equal(formatTokens(2400000), '2.4M');
  assert.equal(formatTokens(123456789), '123M');
});
