import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDue, isOverdue, daysUntil } from '../src/dates.mjs';
import { NOW } from './helpers.mjs';

test('parses absolute and relative due dates', () => {
  assert.equal(parseDue('2026-11-03', NOW), '2026-11-03');
  assert.equal(parseDue('today', NOW), '2026-11-01');
  assert.equal(parseDue('Tomorrow', NOW), '2026-11-02');
  assert.equal(parseDue('+30d', NOW), '2026-12-01');
});

test('rejects impossible dates', () => {
  for (const bad of ['2026-02-30', '2026-13-01', 'next week', '+d', '']) assert.throws(() => parseDue(bad, NOW), /Invalid due date/, bad);
});

test('a task is overdue only after its due day', () => {
  assert.equal(isOverdue({ due: '2026-10-31', status: 'open' }, NOW), true);
  assert.equal(isOverdue({ due: '2026-11-02', status: 'open' }, NOW), false);
  assert.equal(isOverdue({ due: '2026-10-31', status: 'done' }, NOW), false);
  assert.equal(isOverdue({ due: null, status: 'open' }, NOW), false);
});

test('counts days until a due date', () => {
  assert.equal(daysUntil('2026-11-01', NOW), 0);
  assert.equal(daysUntil('2026-11-08', NOW), 7);
});
