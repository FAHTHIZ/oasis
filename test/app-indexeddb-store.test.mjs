import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { IndexedDBStore } from '../app/core/workspace.mjs';

test('IndexedDBStore keeps projects, files and values through idb', async () => {
  const store = new IndexedDBStore('oasis-test-' + Math.random());
  await store.putProject({ id: 'a', name: 'A', updatedAt: 1 });
  await store.putProject({ id: 'b', name: 'B', updatedAt: 2 });
  assert.deepEqual((await store.listProjects()).map((p) => p.id), ['b', 'a']);
  await store.putFile('a', { path: 'x.txt', content: 'hi' });
  await store.putFile('a', { path: 'y.txt', content: 'yo' });
  await store.putFile('b', { path: 'x.txt', content: 'other' });
  assert.deepEqual(await store.getFile('a', 'x.txt'), { path: 'x.txt', content: 'hi' });
  assert.equal((await store.listFiles('a')).length, 2);
  await store.deleteFile('a', 'y.txt');
  assert.equal(await store.getFile('a', 'y.txt'), null);
  await store.setValue('k', { v: 1 });
  assert.deepEqual(await store.getValue('k'), { v: 1 });
  await store.deleteProject('a');
  assert.equal(await store.getProject('a'), null);
  assert.deepEqual(await store.listFiles('a'), []);
  assert.equal((await store.listFiles('b')).length, 1);
});

test('IndexedDBStore steps aside when the database is deleted and reopens after', async () => {
  const name = 'oasis-test-' + Math.random();
  const store = new IndexedDBStore(name);
  await store.putProject({ id: 'a', updatedAt: 1 });
  await deleteDB(name); // would hang if the open connection did not close on versionchange
  assert.deepEqual(await store.listProjects(), []);
});
