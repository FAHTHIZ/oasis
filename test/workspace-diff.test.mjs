import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readWorkspaceDiff } from '../src/worktrees.mjs';
import { sensitivePath } from '../src/tools.mjs';
import { startOasisWebServer } from '../src/web.mjs';

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wsdiff-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid');
  await writeFile(path.join(root, 'math.js'), 'export const add = (a, b) => a - b;\n');
  await writeFile(path.join(root, 'keep.txt'), 'same\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  return { root, git };
}

test('readWorkspaceDiff reports tracked and untracked changes and hides secret files', async (t) => {
  const { root } = await repo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'math.js'), 'export const add = (a, b) => a + b;\n');
  await writeFile(path.join(root, 'notes.md'), 'line one\nline two\n');
  await writeFile(path.join(root, '.env'), 'API_KEY=super-secret-value\n');
  const result = await readWorkspaceDiff(root, { isSecretPath: sensitivePath });
  assert.equal(result.git, true);
  assert.equal(result.branch, 'main');
  const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
  assert.deepEqual([byPath['math.js'].added, byPath['math.js'].removed, byPath['math.js'].status], [1, 1, 'modified']);
  assert.deepEqual([byPath['notes.md'].added, byPath['notes.md'].status], [2, 'untracked']);
  assert.equal(byPath['keep.txt'], undefined);
  assert.equal(byPath['.env'], undefined);
  assert.deepEqual(result.hiddenFiles, ['.env']);
  assert.match(result.diff, /-export const add = \(a, b\) => a - b;/);
  assert.match(result.diff, /\+export const add = \(a, b\) => a \+ b;/);
  assert.match(result.diff, /\+line two/);
  assert.doesNotMatch(result.diff, /super-secret-value/);
});

test('readWorkspaceDiff hides tracked secret-file edits and handles repos without commits', async (t) => {
  const { root, git } = await repo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'));
  await writeFile(path.join(root, 'config', 'server.pem'), 'old\n');
  git('add', '-A'); git('commit', '-qm', 'pem');
  await writeFile(path.join(root, 'config', 'server.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n');
  const result = await readWorkspaceDiff(root, { isSecretPath: sensitivePath });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.hiddenFiles, ['config/server.pem']);
  assert.equal(result.diff, '');

  const fresh = await mkdtemp(path.join(os.tmpdir(), 'oasis-wsdiff-fresh-'));
  t.after(() => rm(fresh, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: fresh });
  await writeFile(path.join(fresh, 'a.txt'), 'hello\n');
  const freshResult = await readWorkspaceDiff(fresh, { isSecretPath: sensitivePath });
  assert.equal(freshResult.base, '');
  assert.deepEqual(freshResult.files.map((f) => f.path), ['a.txt']);

  const plain = await mkdtemp(path.join(os.tmpdir(), 'oasis-wsdiff-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  assert.equal((await readWorkspaceDiff(plain)).git, false);
});

test('GET /api/workspace/diff requires the runtime token and returns the live diff', async (t) => {
  const { root } = await repo();
  const cfg = await mkdtemp(path.join(os.tmpdir(), 'oasis-wsdiff-cfg-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(cfg, { recursive: true, force: true })]));
  await writeFile(path.join(root, 'math.js'), 'export const add = (a, b) => a + b;\n');
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env: { ...process.env, OASIS_CONFIG_DIR: cfg }, token });
  t.after(() => app.close());
  const url = 'http://127.0.0.1:' + app.port + '/api/workspace/diff';
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.git, true);
  assert.deepEqual(body.files.map((f) => f.path), ['math.js']);
  assert.match(body.diff, /a \+ b/);
});
