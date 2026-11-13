import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { executeTool } from '../src/tools.mjs';

process.env.OASIS_REQUIRE_READ_BEFORE_EDIT = '0';

test('write_file append builds a file over several calls', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-append-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { root, env: process.env, session: { root } };
  await executeTool('write_file', { path: 'big.js', content: 'const a = 1;\n' }, context);
  const second = await executeTool('write_file', { path: 'big.js', content: 'const b = 2;\n', append: true }, context);
  assert.equal(second.appended, true);
  assert.equal(await readFile(path.join(root, 'big.js'), 'utf8'), 'const a = 1;\nconst b = 2;\n');
  // Appending to a missing file creates it.
  await executeTool('write_file', { path: 'new.txt', content: 'one\n', append: true }, context);
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'one\n');
  // A plain write still replaces.
  await executeTool('write_file', { path: 'big.js', content: 'reset\n' }, context);
  assert.equal(await readFile(path.join(root, 'big.js'), 'utf8'), 'reset\n');
});
