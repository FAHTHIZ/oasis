import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppResolver } from '../src/app-server.mjs';

test('app resolver picks up a shared module added after startup (git pull while running)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-app-graph-'));
  await mkdir(path.join(root, 'app'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'old.mjs'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'src', 'secret.mjs'), 'export const s = 1;\n');
  await writeFile(path.join(root, 'app', 'main.mjs'), "import { a } from '../src/old.mjs';\n");
  let clock = 0;
  const resolve = createAppResolver(root, { refreshMs: 2000, now: () => clock });
  assert.ok((await resolve('/src/old.mjs')).file.endsWith('old.mjs'));
  assert.equal(await resolve('/src/new.mjs'), null);

  await writeFile(path.join(root, 'src', 'new.mjs'), 'export const b = 2;\n');
  await writeFile(path.join(root, 'app', 'main.mjs'), "import { a } from '../src/old.mjs';\nimport { b } from '../src/new.mjs';\n");
  assert.equal(await resolve('/src/new.mjs'), null, 'rebuilds are rate limited');
  clock += 2500;
  assert.ok((await resolve('/src/new.mjs')).file.endsWith('new.mjs'));
  clock += 2500;
  assert.equal(await resolve('/src/secret.mjs'), null, 'modules the app does not import stay hidden');
});
