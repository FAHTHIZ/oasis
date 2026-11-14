import test from 'node:test';
import assert from 'node:assert/strict';
import { truncate, relativeDue, formatTask } from '../src/format.mjs';
import { NOW } from './helpers.mjs';

test('truncates long titles with an ellipsis', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('abcdefghijkl', 5), 'abcd…');
});

test('describes due dates relative to now', () => {
  assert.equal(relativeDue({ due: '2026-11-02', status: 'open' }, NOW), 'tomorrow');
  assert.equal(relativeDue({ due: '2026-11-04', status: 'open' }, NOW), 'in 3 days');
  assert.equal(relativeDue({ due: '2026-10-01', status: 'open' }, NOW), 'overdue');
});

test('formats a task line', () => {
  assert.equal(formatTask({ id: 7, title: 'Ship', priority: 'high', status: 'open', due: '2026-11-02', tags: ['rel'] }, { now: NOW }), '  7 [ ] ! Ship #rel (tomorrow)');
});
