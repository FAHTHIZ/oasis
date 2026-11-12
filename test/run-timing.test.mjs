import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTiming, runElapsed, timingSplit, groupStats } from '../app/core/timeline.mjs';

test('group time is first step start to last step end; tools + thinking = span', () => {
  const t = groupTiming([
    { startedAt: 1000, endedAt: 1080, ok: true },
    { startedAt: 44000, endedAt: 44100, ok: true },
    { startedAt: 46000, endedAt: 48000, ok: true }
  ]);
  assert.equal(t.spanMs, 47000);
  assert.equal(t.toolMs, 80 + 100 + 2000);
  assert.equal(t.toolMs + t.thinkingMs, t.spanMs);
  assert.equal(timingSplit(t), 'tools 2s · thinking 45s');
});

test('overlapping (parallel) steps count once in tool time', () => {
  const t = groupTiming([{ startedAt: 0 + 1, endedAt: 5001, ok: true }, { startedAt: 1001, endedAt: 3001, ok: true }]);
  assert.equal(t.toolMs, 5000);
  assert.equal(t.thinkingMs, 0);
});

test('a running step counts to now; durationMs fills a missing end', () => {
  assert.equal(groupTiming([{ startedAt: 1000 }], 4000).spanMs, 3000);
  assert.equal(groupTiming([{ startedAt: 1000, durationMs: 250, ok: true }]).spanMs, 250);
  assert.equal(groupTiming([]), null);
  assert.equal(groupStats([{ startedAt: 10, endedAt: 30, ok: true }, { startedAt: 50, endedAt: 70, ok: true }]).durationMs, 60);
});

test('header and groups can never contradict each other (randomised)', () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 400; run++) {
    const runStart = 1_000_000 + rand(10_000);
    let clock = runStart + rand(3000);
    const groups = [];
    for (let g = 0; g < 1 + rand(5); g++) {
      clock += rand(60_000); // the model thinking before the group
      const steps = [];
      for (let s = 0; s < 1 + rand(6); s++) {
        const start = clock + rand(20_000);
        const end = start + rand(5000);
        steps.push({ startedAt: start, endedAt: end, ok: true });
        clock = Math.max(clock, start);
        if (rand(3)) clock = end;
      }
      clock = Math.max(clock, ...steps.map((s) => s.endedAt));
      groups.push(steps);
    }
    const now = clock + rand(30_000);
    const header = runElapsed(runStart, now);
    let total = 0;
    for (const steps of groups) {
      const t = groupTiming(steps, now);
      assert.ok(t.spanMs <= header, 'a group never exceeds the header');
      assert.equal(t.toolMs + t.thinkingMs, t.spanMs, 'tools + thinking = group time');
      assert.ok(t.toolMs <= t.spanMs);
      assert.equal(groupStats(steps).durationMs, t.spanMs, 'the group head shows the same span');
      total += t.spanMs;
    }
    assert.ok(total <= header, 'the groups together never exceed the header');
  }
});

test('runElapsed: run start to now, zero without a start', () => {
  assert.equal(runElapsed(1000, 6000), 5000);
  assert.equal(runElapsed(0, 6000), 0);
  assert.equal(runElapsed(9000, 6000), 0);
});
