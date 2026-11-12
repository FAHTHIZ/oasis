import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { startOasisWebServer } from '../src/web.mjs';

test('Discard restores a tracked file from HEAD without running repo filters, and refuses everything else', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-discard-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  await writeFile(path.join(root, 'a.txt'), 'original\n\n');
  await writeFile(path.join(root, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  await writeFile(path.join(root, 'gone.txt'), 'bring me back\n');
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=evil\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  // A hostile repository filter: must never run when discarding.
  git('config', 'filter.evil.smudge', 'touch "' + path.join(root, 'PWNED') + '"; cat');
  await writeFile(path.join(root, 'a.txt'), 'changed\n');
  await writeFile(path.join(root, 'run.sh'), 'broken\n');
  await unlink(path.join(root, 'gone.txt'));
  await writeFile(path.join(root, 'new.txt'), 'untracked\n');
  await writeFile(path.join(root, 'outside.txt'), 'x');
  await symlink(path.join(root, 'outside.txt'), path.join(root, 'link.txt'));
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env: { ...process.env, OASIS_CONFIG_DIR: path.join(root, '.cfg') }, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port + '/api/workspace/discard';
  const post = (body, headers = { authorization: 'Bearer ' + app.token }) => fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await post({ path: 'a.txt' }, {})).status, 401);
  const ok = await post({ path: 'a.txt' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { path: 'a.txt', restored: true });
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'original\n\n', 'exact bytes, trailing newlines kept');
  assert.equal((await post({ path: 'run.sh' })).status, 200);
  assert.equal((await stat(path.join(root, 'run.sh'))).mode & 0o777, 0o755);
  assert.equal((await post({ path: 'gone.txt' })).status, 200, 'a deleted tracked file comes back');
  assert.equal(await readFile(path.join(root, 'gone.txt'), 'utf8'), 'bring me back\n');
  assert.equal(existsSync(path.join(root, 'PWNED')), false, 'the smudge filter did not run');

  const untracked = await post({ path: 'new.txt' });
  assert.equal(untracked.status, 404);
  assert.match((await untracked.json()).error, /not in the last commit/);
  assert.equal(existsSync(path.join(root, 'new.txt')), true);
  assert.equal((await post({ path: '../etc/passwd' })).status, 403);
  assert.equal((await post({ path: '.git/config' })).status, 403);
  assert.equal((await post({ path: 'link.txt' })).status, 403);
  assert.equal((await post({ path: '' })).status, 400);
});

test('RuntimeWorkspace.discard posts the path and drops cached listings', async () => {
  const { RuntimeWorkspace } = await import('../app/core/runtime.mjs');
  const calls = [];
  const ws = new RuntimeWorkspace({ api: async (url, options) => { calls.push([url, options]); return { path: 'a.js', restored: true }; } }, { workspaceName: 'p' });
  ws.cache = ['a.js']; ws.diffCache = { files: [] };
  assert.deepEqual(await ws.discard('a.js'), { path: 'a.js', restored: true });
  assert.deepEqual(calls, [['/api/workspace/discard', { method: 'POST', body: { path: 'a.js' } }]]);
  assert.equal(ws.cache, null);
  assert.equal(ws.diffCache, null);
});
