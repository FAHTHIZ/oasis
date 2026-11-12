import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDeployer, findSiteDir, siteFiles, pagesUrl, deployCommand } from '../src/deploy.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function project() {
  const base = mkdtempSync(path.join(tmpdir(), 'oasis-deploy-'));
  const root = path.join(base, 'site');
  const remote = path.join(base, 'remote.git');
  mkdirSync(root);
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  git(base, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', remote);
  writeFileSync(path.join(root, 'README.md'), '# site\n');
  writeFileSync(path.join(root, '.gitignore'), 'dist/\nsecret-notes.txt\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return { root, remote, git };
}
const quiet = () => {};

test('the site folder is the build output with an index.html, else the root', async () => {
  const { root } = project();
  await assert.rejects(findSiteDir(root), /no index\.html/);
  writeFileSync(path.join(root, 'index.html'), 'root');
  assert.equal(await findSiteDir(root), root);
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist', 'index.html'), 'built');
  assert.equal(await findSiteDir(root), path.join(root, 'dist'));
  assert.equal(await findSiteDir(root, 'dist'), path.join(root, 'dist'));
});

test('secrets and tool folders are never published', async () => {
  const { root } = project();
  mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true });
  mkdirSync(path.join(root, 'dist', 'node_modules'));
  for (const file of ['index.html', 'assets/app.js', '.env', '.env.local', 'server.pem', 'node_modules/x.js']) writeFileSync(path.join(root, 'dist', file), 'x');
  const { files, skipped } = await siteFiles(path.join(root, 'dist'));
  assert.deepEqual(files, ['assets/app.js', 'index.html']);
  assert.deepEqual(skipped.sort(), ['.env', '.env.local', 'server.pem']);
});

test('deploy commits the build output to gh-pages without touching the working branch', async () => {
  const { root, remote, git } = project();
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist', 'index.html'), '<h1>v1</h1>');
  writeFileSync(path.join(root, 'dist', '.env'), 'TOKEN=1');
  writeFileSync(path.join(root, 'notes.txt'), 'uncommitted');
  const before = git(root, 'status', '--porcelain').stdout;
  const deployer = createDeployer({ cwd: root, env, log: quiet });
  const first = await deployer.deploy({ noBuild: true });
  assert.equal(first.dir, 'dist');
  assert.equal(git(remote, 'show', 'gh-pages:index.html').stdout, '<h1>v1</h1>');
  assert.deepEqual(git(remote, 'ls-tree', '--name-only', 'gh-pages').stdout.trim().split('\n').sort(), ['.nojekyll', 'index.html']);
  assert.equal(git(root, 'status', '--porcelain').stdout, before, 'working tree and index unchanged');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main');
  const again = await deployer.deploy({ noBuild: true });
  assert.equal(again.unchanged, true);
  writeFileSync(path.join(root, 'dist', 'index.html'), '<h1>v2</h1>');
  await deployer.deploy({ noBuild: true });
  assert.equal(git(remote, 'show', 'gh-pages:index.html').stdout, '<h1>v2</h1>');
  assert.equal(git(remote, 'rev-list', '--count', 'gh-pages').stdout.trim(), '2', 'history is kept');
});

test('a root deploy leaves out Git-ignored files', async () => {
  const { root, remote, git } = project();
  writeFileSync(path.join(root, 'index.html'), 'home');
  writeFileSync(path.join(root, 'secret-notes.txt'), 'private');
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist', 'other.txt'), 'ignored dir');
  await createDeployer({ cwd: root, env, log: quiet }).deploy({ noBuild: true });
  const names = git(remote, 'ls-tree', '-r', '--name-only', 'gh-pages').stdout.trim().split('\n').sort();
  assert.deepEqual(names, ['.gitignore', '.nojekyll', 'README.md', 'index.html']);
});

test('Pages URLs and the dry run', async () => {
  assert.equal(pagesUrl('FAHTHIZ', 'oasis'), 'https://fahthiz.github.io/oasis/');
  assert.equal(pagesUrl('FAHTHIZ', 'fahthiz.github.io'), 'https://fahthiz.github.io/');
  const { root, remote, git } = project();
  writeFileSync(path.join(root, 'index.html'), 'home');
  let out = '';
  await deployCommand(['--dry-run'], { cwd: root, env, stdout: { write: (text) => { out += text; } }, deployer: createDeployer({ cwd: root, env, log: quiet }) });
  assert.match(out, /Would publish 3 files from \. to gh-pages/);
  assert.notEqual(git(remote, 'rev-parse', '--verify', '-q', 'gh-pages').status, 0, 'nothing pushed');
  await assert.rejects(deployCommand(['--bogus'], { cwd: root, env, stdout: { write() {} } }), /Unknown option/);
});

test('Pages is turned on through the GitHub API when it is off', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'gh' && args.length === 2) throw new Error('Not Found (HTTP 404)');
    if (command === 'gh') return JSON.stringify({ html_url: 'https://fahthiz.github.io/demo/' });
    return '';
  };
  const url = await createDeployer({ exec, log: quiet }).turnOnPages({ owner: 'FAHTHIZ', repo: 'demo' }, 'gh-pages');
  assert.equal(url, 'https://fahthiz.github.io/demo/');
  assert.ok(calls.some((call) => call.includes('-X POST repos/FAHTHIZ/demo/pages') && call.includes('source[branch]=gh-pages')));
});
