import test from 'node:test';
import assert from 'node:assert/strict';
import { describeJob, formatWhen } from '../src/routines.mjs';

const now = Date.parse('2026-11-25T14:00:00.000Z');

test('routine times are shown in the routine time zone with a relative hint', () => {
  assert.match(formatWhen('2026-11-26T03:00:00.000Z', { timezone: 'Asia/Dhaka', now }), /^2026-11-26 09:00 \S+ \(in 13h\)$/);
  assert.match(formatWhen('2026-11-25T14:05:00.000Z', { timezone: 'UTC', now }), /^2026-11-25 14:05 UTC \(in 5m\)$/);
  assert.match(formatWhen('2026-11-25T13:00:00.000Z', { timezone: 'UTC', now }), /\(1h ago\)$/);
  assert.match(formatWhen('2026-11-25T14:00:10.000Z', { timezone: 'UTC', now }), /\(now\)$/);
  assert.equal(formatWhen('not a date'), 'not a date');
});

test('describeJob no longer prints a raw UTC ISO timestamp', () => {
  const line = describeJob({ id: 'rt-1', schedule: { display: 'daily at 9am' }, timezone: 'UTC', nextRunAt: '2026-11-26T09:00:00.000Z' }, { now });
  assert.match(line, /next 2026-11-26 09:00 UTC \(in 19h\)/);
  assert.doesNotMatch(line, /\.000Z/);
});
