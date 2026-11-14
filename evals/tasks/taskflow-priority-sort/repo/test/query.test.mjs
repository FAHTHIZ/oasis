import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTasks, sortTasks, paginate } from '../src/query.mjs';
import { NOW } from './helpers.mjs';

const tasks = [
  { id: 1, title: 'b', priority: 'low', status: 'open', due: '2026-11-05', tags: ['home'] },
  { id: 2, title: 'a', priority: 'high', status: 'done', due: null, tags: ['work'] },
  { id: 3, title: 'c', priority: 'normal', status: 'open', due: '2026-10-30', tags: ['work'] },
  { id: 4, title: 'd', priority: 'high', status: 'open', due: '2026-11-02', tags: [] }
];

test('filters by status, tag, priority and overdue', () => {
  assert.deepEqual(filterTasks(tasks, { status: 'open' }).map((t) => t.id), [1, 3, 4]);
  assert.deepEqual(filterTasks(tasks, { status: 'all', tag: 'work' }).map((t) => t.id), [2, 3]);
  assert.deepEqual(filterTasks(tasks, { priority: 'high' }).map((t) => t.id), [2, 4]);
  assert.deepEqual(filterTasks(tasks, { overdue: true, now: NOW }).map((t) => t.id), [3]);
});

test('sorts by due date with undated tasks last', () => {
  assert.deepEqual(sortTasks(tasks, 'due').map((t) => t.id), [3, 4, 1, 2]);
  assert.throws(() => sortTasks(tasks, 'color'), /Unknown sort key/);
});

test('paginates from page 1', () => {
  const items = Array.from({ length: 5 }, (_, i) => i);
  assert.deepEqual(paginate(items, 1, 2), { items: [0, 1], page: 1, pages: 3, total: 5 });
  assert.deepEqual(paginate(items, 3, 2).items, [4]);
  assert.throws(() => paginate(items, 0, 2), /positive integer/);
});
