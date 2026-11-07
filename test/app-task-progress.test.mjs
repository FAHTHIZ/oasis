import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTaskProgress, extractRuntimeTodos } from '../app/core/task-progress.mjs';

const app = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../app/core/runtime.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8');

test('task progress normalizes invalid entries and bounds the visible checklist', () => {
  assert.deepEqual(normalizeTaskProgress(null).items, []);
  const items = Array.from({ length: 52 }, (_, index) => ({ content: index === 1 ? '  ' : 'Step ' + index, status: index === 0 ? 'unknown' : 'pending' }));
  const progress = normalizeTaskProgress(items);
  assert.equal(progress.total, 49);
  assert.equal(progress.items[0].status, 'pending');
  assert.equal(progress.items[0].content, 'Step 0');
});

test('task progress calculates current, next and completed steps without inventing time estimates', () => {
  const progress = normalizeTaskProgress([
    { content: 'Inspect the project', status: 'completed' },
    { content: 'Make the change', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' }
  ]);
  assert.equal(progress.total, 3);
  assert.equal(progress.completed, 1);
  assert.equal(progress.activeIndex, 1);
  assert.equal(progress.nextIndex, 2);
  assert.equal(progress.percent, 33);
  assert.equal(progress.finished, false);
});

test('completed task plans remain representable as a finished summary', () => {
  const progress = normalizeTaskProgress([{ content: 'Inspect', status: 'completed' }, { content: 'Verify', status: 'completed' }]);
  assert.equal(progress.finished, true);
  assert.equal(progress.percent, 100);
  assert.equal(progress.completed, 2);
});

test('runtime adapter accepts native plan entries and wrapped todo_write results', () => {
  const entries = [{ content: 'Inspect', status: 'completed' }, { content: 'Implement', status: 'in_progress' }];
  assert.deepEqual(extractRuntimeTodos({ entries }), entries);
  assert.deepEqual(extractRuntimeTodos({ result: { todos: entries, remaining: 1 } }), entries);
  assert.deepEqual(extractRuntimeTodos(JSON.stringify({ todos: entries })), entries);
  assert.deepEqual(extractRuntimeTodos({ todos: [] }), []);
  assert.equal(extractRuntimeTodos('not a serialized checklist'), null);
  assert.equal(extractRuntimeTodos({ result: { message: 'done' } }), null);
});

test('browser displays an accessible, collapsible progress guide and explicit tool states', () => {
  assert.match(html, /id="todos"[^>]*role="region"[^>]*aria-live="polite"/);
  assert.match(app, /role', 'progressbar'/);
  assert.match(app, /aria-current', 'step'/);
  assert.match(app, /All steps completed/);
  assert.match(app, /statusLabel = tool\.ok === undefined \? 'Working' : tool\.ok \? 'Done' : 'Failed'/);
  assert.match(runtime, /case 'plan':\s+case 'todos':/);
  assert.match(runtime, /data\.name === 'todo_write'/);
  assert.match(css, /\.task-progress-track/);
  assert.match(css, /\.tool-status/);
});
