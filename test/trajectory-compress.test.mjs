import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { saveSession } from '../src/sessions.mjs';
import { exportSessions, compressionOptions, compressionLine } from '../src/trajectories.mjs';
import { compressMessages, trajectoryUnits, SUMMARY_PREFIX, SUMMARY_FALLBACK, SUMMARY_NOTICE, newCompressionTotals, addCompressionMetrics, compressionReport } from '../src/trajectory-compress.mjs';

// A long run: system, task, then many read_file call/result pairs, then the answer.
function longRun(steps = 30, size = 2000) {
  const messages = [{ role: 'system', content: 'You are OASIS.' }, { role: 'user', content: 'Fix the failing test in src/app.js' }];
  for (let index = 0; index < steps; index++) {
    messages.push({ role: 'assistant', content: index === 0 ? 'Looking around.' : '', tool_calls: [{ id: 'c' + index, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/f' + index + '.js' }) } }] });
    messages.push({ role: 'tool', tool_call_id: 'c' + index, content: 'line '.repeat(size / 5) });
  }
  messages.push({ role: 'assistant', content: 'Fixed: the off-by-one in src/app.js; tests pass.' });
  return messages;
}

test('tool calls and their results form one unit', () => {
  const units = trajectoryUnits(longRun(3, 10));
  assert.deepEqual(units.map((unit) => unit.map((m) => m.role).join('+')), ['system', 'user', 'assistant+tool', 'assistant+tool', 'assistant+tool', 'assistant']);
});

test('short trajectories are left alone', async () => {
  const messages = longRun(2, 50);
  const { messages: out, metrics } = await compressMessages(messages, { targetTokens: 15250, summarize: async () => 'x' });
  assert.equal(out, messages);
  assert.equal(metrics.skipped_under_target, true);
  assert.equal(metrics.was_compressed, false);
  assert.equal(metrics.summarization_api_calls, 0);
});

test('long trajectories keep the head and tail and summarize just enough of the middle', async () => {
  const messages = longRun(30, 2000);
  let seen = '';
  const { messages: out, metrics } = await compressMessages(messages, { targetTokens: 8000, summaryTokens: 300, summarize: async (transcript, tokens) => { seen = transcript; assert.equal(tokens, 300); return 'The assistant read src/f1.js to src/fN.js.'; } });
  assert.equal(metrics.was_compressed, true);
  assert.ok(metrics.compressed_tokens <= 8000, String(metrics.compressed_tokens));
  assert.equal(metrics.still_over_limit, false);
  assert.ok(metrics.tokens_saved > 0);
  assert.equal(metrics.summarization_api_calls, 1);
  assert.equal(metrics.summarization_errors, 0);
  // First system/user/assistant+tool unit stay; the system prompt gets the notice.
  assert.equal(out[0].content, 'You are OASIS.' + SUMMARY_NOTICE);
  assert.equal(out[1].content, 'Fix the failing test in src/app.js');
  assert.equal(out[2].tool_calls[0].id, 'c0');
  assert.equal(out[3].tool_call_id, 'c0');
  const summary = out.find((m) => m.role === 'user' && m.content.startsWith(SUMMARY_PREFIX));
  assert.equal(summary.content, SUMMARY_PREFIX + ' The assistant read src/f1.js to src/fN.js.');
  assert.match(seen, /TOOL CALL read_file: \{"path":"src\/f1\.js"\}/);
  // Only as much as needed was summarized: later pairs survive verbatim, and the end is intact.
  assert.equal(out.at(-1).content, 'Fixed: the off-by-one in src/app.js; tests pass.');
  assert.ok(out.some((m) => m.tool_call_id === 'c29'));
  // Every surviving tool result still follows its call.
  for (let index = 0; index < out.length; index++) {
    if (out[index].role !== 'tool') continue;
    let back = index - 1;
    while (out[back].role === 'tool') back--;
    assert.ok(out[back].tool_calls.some((call) => call.id === out[index].tool_call_id));
  }
  assert.equal(metrics.compression_region.start_idx, 4);
  assert.equal(metrics.original_turns - metrics.compressed_turns, metrics.turns_removed);
});

test('a failed summary falls back to the fixed notice', async () => {
  const { messages, metrics } = await compressMessages(longRun(30, 2000), { targetTokens: 8000, summarize: async () => { throw new Error('down'); } });
  assert.ok(messages.some((m) => m.content === SUMMARY_FALLBACK));
  assert.equal(metrics.summarization_errors, 1);
  const none = await compressMessages(longRun(30, 2000), { targetTokens: 8000 });
  assert.ok(none.messages.some((m) => m.content === SUMMARY_FALLBACK));
});

test('dataset totals follow the Hermes compression_metrics.json shape', async () => {
  const totals = newCompressionTotals();
  addCompressionMetrics(totals, (await compressMessages(longRun(30, 2000), { targetTokens: 8000, summarize: async () => 'ok' })).metrics);
  addCompressionMetrics(totals, (await compressMessages(longRun(1, 10), { targetTokens: 8000 })).metrics);
  const report = compressionReport(totals);
  assert.equal(report.summary.total_trajectories, 2);
  assert.equal(report.summary.trajectories_compressed, 1);
  assert.equal(report.summary.trajectories_skipped_under_target, 1);
  assert.equal(report.summary.compression_rate, 0.5);
  assert.ok(report.tokens.total_saved > 0);
  assert.equal(report.summarization.success_rate, 1);
  assert.match(compressionLine(report), /^Compressed 1 of 2 trajectories/);
});

test('--compress takes an optional token count and does not eat session ids', () => {
  assert.equal(compressionOptions(['--all']), null);
  assert.equal(compressionOptions(['--compress', 'abc123']).targetTokens, undefined);
  assert.deepEqual(compressionOptions(['--compress', '9000', '--summary-tokens', '500', '--keep-last', '2', '--metrics', 'm.json']), { targetTokens: 9000, summaryTokens: 500, keepLast: 2, metricsFile: 'm.json' });
  assert.throws(() => compressionOptions(['--compress', '--keep-last', 'x']), /whole number/);
});

test('oasis sessions export --compress writes compressed records and metrics', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-squeeze-'));
  const env = { OASIS_CONFIG_DIR: path.join(base, 'cfg') };
  try {
    const long = await saveSession({ root: base, messages: longRun(30, 2000), config: { model: 'm' } }, { env });
    const out = path.join(base, 'out.jsonl');
    const metricsFile = path.join(base, 'metrics.json');
    let report = null;
    await exportSessions(base, [long.id, '--compress', '8000', '--format', 'sharegpt', '--metrics', metricsFile, '--out', out], { env, summarize: async () => 'Read many files; token=supersecret123456 seen.', onCompression: (value) => { report = value; } });
    const line = JSON.parse((await readFile(out, 'utf8')).trim());
    const summary = line.conversations.find((turn) => turn.from === 'human' && turn.value.startsWith(SUMMARY_PREFIX));
    assert.ok(summary);
    assert.doesNotMatch(summary.value, /supersecret/);
    assert.equal(line.compression_metrics.was_compressed, true);
    assert.equal(report.summary.trajectories_compressed, 1);
    assert.equal(JSON.parse(await readFile(metricsFile, 'utf8')).summary.total_trajectories, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
