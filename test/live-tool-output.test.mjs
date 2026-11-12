import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveOutputRelay, fullToolOutputText } from '../src/web.mjs';
import { toolActivityOutcome } from '../src/tool-activity.mjs';
import { splitStableMarkdown, renderMarkdown } from '../app/markdown.mjs';

test('live output is batched per call and stream, then flushed when the call ends', async () => {
  const sent = [];
  const relay = createLiveOutputRelay((event) => sent.push(event), { intervalMs: 20 });
  relay.push('c1', 'stdout', 'one\n');
  relay.push('c1', 'stdout', 'two\n');
  relay.push('c1', 'stderr', 'warn\n');
  assert.equal(sent.length, 0, 'nothing is sent before the batch interval');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(sent, [{ callId: 'c1', stream: 'stdout', text: 'one\ntwo\n' }, { callId: 'c1', stream: 'stderr', text: 'warn\n' }]);
  relay.push('c1', 'stdout', 'three\n');
  relay.finish('c1');
  assert.equal(sent.at(-1).text, 'three\n', 'finish flushes what is left');
  assert.equal(relay.size(), 0);
});

test('live output stops at its cap and says so once', () => {
  const sent = [];
  const relay = createLiveOutputRelay((event) => sent.push(event), { intervalMs: 1000, maxChars: 10 });
  relay.push('c', 'stdout', '0123456789abcdef');
  relay.push('c', 'stdout', 'more');
  relay.finish('c');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '0123456789');
  assert.equal(sent[0].capped, true);
});

test('live output never carries secrets', () => {
  const sent = [];
  const relay = createLiveOutputRelay((event) => sent.push(event), { intervalMs: 1000 });
  relay.push('c', 'stdout', 'token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n');
  relay.finish('c');
  assert.ok(!sent[0].text.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('full tool output joins stdout and stderr and notes a failing exit code', () => {
  assert.deepEqual(fullToolOutputText({ stdout: 'ok', stderr: 'bad', exitCode: 2 }), { text: 'ok\nbad\n[exit 2]', truncated: false });
  assert.equal(fullToolOutputText({ stdout: '', stderr: '' }).text, '(no output)');
  const big = fullToolOutputText('x'.repeat(2_200_000));
  assert.equal(big.truncated, true);
  assert.ok(big.text.length < 1_100_000);
});

test('tool outcomes say what really happened', () => {
  assert.equal(toolActivityOutcome({ approved: false, error: 'User declined' }), 'declined');
  assert.equal(toolActivityOutcome({ blocked: true }), 'blocked');
  assert.equal(toolActivityOutcome({ cancelled: true }), 'cancelled');
  assert.equal(toolActivityOutcome({ timedOut: true }), 'timed_out');
  assert.equal(toolActivityOutcome({ timedOut: true, movedToBackground: true }), 'ok');
  assert.equal(toolActivityOutcome({ stdout: 'hi', exitCode: 0 }), 'ok');
  assert.equal(toolActivityOutcome('plain text'), 'ok');
});

test('streamed Markdown freezes finished blocks; the frozen part plus the tail renders like the whole', () => {
  const samples = [
    '# Title\n\nFirst paragraph.\n\n- one\n- two\n\nLast line still being wri',
    'Intro\n\n```js\nconst a = 1;\n```\n\nAfter the code',
    'Only one block so far',
    '| a | b |\n|---|---|\n| 1 | 2 |\n\nThen text'
  ];
  for (const source of samples) {
    const { stable } = splitStableMarkdown(source);
    assert.ok(source.startsWith(stable));
    assert.equal(renderMarkdown(stable) + renderMarkdown(source.slice(stable.length)), renderMarkdown(source), source);
  }
  assert.equal(splitStableMarkdown('Only one block so far').stable, '');
  assert.equal(splitStableMarkdown('Open fence\n\n```js\nconst a').stable, 'Open fence\n\n', 'an open code block stays in the tail');
});
