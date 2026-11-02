import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, symlink, lstat, link, readdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/atomic-write.mjs';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'oasis-atomic-'));

test('atomicWriteFile replaces content and leaves no temporary files', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'old');
  const result = await atomicWriteFile(file, 'new');
  assert.equal(await readFile(file, 'utf8'), 'new');
  assert.equal(result.atomic, true);
  assert.deepEqual(await readdir(dir), ['a.txt']);
});

test('atomicWriteFile keeps the permission bits of an existing file', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  const file = path.join(dir, 'run.sh');
  await writeFile(file, '#!/bin/sh\n');
  await chmod(file, 0o755);
  await atomicWriteFile(file, '#!/bin/sh\necho hi\n');
  assert.equal((await stat(file)).mode & 0o777, 0o755);
});

test('atomicWriteFile writes through a symlink instead of replacing it', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  const real = path.join(dir, 'real.txt');
  const alias = path.join(dir, 'alias.txt');
  await writeFile(real, 'old');
  await symlink(real, alias);
  await atomicWriteFile(alias, 'new');
  assert.ok((await lstat(alias)).isSymbolicLink());
  assert.equal(await readFile(real, 'utf8'), 'new');
});

test('atomicWriteFile keeps hard links intact by writing in place', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  await writeFile(a, 'old');
  await link(a, b);
  const result = await atomicWriteFile(a, 'new');
  assert.equal(result.atomic, false);
  assert.equal(await readFile(b, 'utf8'), 'new');
});

test('atomicWriteFile creates new files with the requested mode', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  const file = path.join(dir, '.env');
  await atomicWriteFile(file, 'KEY=1', { encoding: 'utf8', mode: 0o600 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
