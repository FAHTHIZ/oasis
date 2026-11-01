import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, updateTask } from '../src/task.mjs';
import { NOW } from './helpers.mjs';

test('creates a validated task', () => {
  const task = createTask({ title: '  Write docs ', priority: 'high', due: 'tomorrow', tags: ['Docs', 'docs', 'v1'] }, { id: 1, now: NOW });
  assert.equal(task.title, 'Write docs');
  assert.equal(task.priority, 'high');
  assert.equal(task.due, '2026-11-02');
  assert.deepEqual(task.tags, ['docs', 'v1']);
  assert.equal(task.status, 'open');
});

test('rejects empty titles, unknown priorities and bad tags', () => {
  assert.throws(() => createTask({ title: ' ' }, { id: 1, now: NOW }), /needs a title/);
  assert.throws(() => createTask({ title: 'x', priority: 'urgent!' }, { id: 1, now: NOW }), /Unknown priority/);
  assert.throws(() => createTask({ title: 'x', tags: ['has space'] }, { id: 1, now: NOW }), /Invalid tag/);
});

test('updates without mutating the original', () => {
  const task = createTask({ title: 'a', tags: ['x'] }, { id: 1, now: NOW });
  const done = updateTask(task, { status: 'done', addTags: ['y'] }, { now: NOW });
  assert.equal(task.status, 'open');
  assert.deepEqual(task.tags, ['x']);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.tags, ['x', 'y']);
  assert.ok(done.completed);
  assert.equal(updateTask(done, { status: 'open' }).completed, undefined);
});
