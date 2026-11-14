import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openStore } from '../src/store.mjs';
import { NOW, tempFile } from './helpers.mjs';

test('adds, updates and removes tasks on disk', async (t) => {
  const file = await tempFile(t);
  const store = await openStore(file, { now: () => NOW });
  await store.add({ title: 'one' });
  await store.add({ title: 'two' });
  await store.update(1, { status: 'done' });
  await store.remove(2);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.tasks.map((x) => [x.id, x.status]), [[1, 'done']]);
  const reopened = await openStore(file, { now: () => NOW });
  assert.equal(reopened.all().length, 1);
});

test('emits completed once per completion', async (t) => {
  const store = await openStore(await tempFile(t), { now: () => NOW });
  const seen = [];
  store.events.on('completed', (task) => seen.push(task.id));
  await store.add({ title: 'one' });
  await store.update(1, { status: 'done' });
  await store.update(1, { status: 'done' });
  assert.deepEqual(seen, [1]);
});
