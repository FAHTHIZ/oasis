import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { gitVisibleFiles, gitignoreRespected } from '../src/git-visible-files.mjs';
import { walkFiles, listWorkspaceFiles } from '../src/tools.mjs';
import { grepWorkspace } from '../src/power-tools.mjs';

async function repo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-gitvis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, '.home');
  await mkdir(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
  const run = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  run('init', '-q');
  await writeFile(path.join(home, 'global-ignore'), 'from-global.txt\n');
  run('config', '--global', 'core.excludesFile', path.join(home, 'global-ignore'));
  await writeFile(path.join(root, '.gitignore'), 'out/\n*.log\n.home/\n');
  await writeFile(path.join(root, '.git', 'info', 'exclude'), 'local-only.txt\n');
  await mkdir(path.join(root, 'src', 'gen'), { recursive: true });
  await mkdir(path.join(root, 'out'));
  await writeFile(path.join(root, 'src', '.gitignore'), 'gen/\n');
  await writeFile(path.join(root, 'src', 'app.js'), 'needle\n');
  await writeFile(path.join(root, 'src', 'gen', 'big.js'), 'needle\n');
  await writeFile(path.join(root, 'out', 'bundle.js'), 'needle\n');
  await writeFile(path.join(root, 'debug.log'), 'needle\n');
  await writeFile(path.join(root, 'local-only.txt'), 'needle\n');
  await writeFile(path.join(root, 'from-global.txt'), 'needle\n');
  await writeFile(path.join(root, 'tracked.txt'), 'needle\n');
  await writeFile(path.join(root, 'gone.txt'), 'x\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  run('add', 'tracked.txt', 'gone.txt', '.gitignore');
  await rm(path.join(root, 'gone.txt'));
  await writeFile(path.join(root, 'untracked.txt'), 'needle\n');
  await symlink(path.join(root, 'tracked.txt'), path.join(root, 'link.txt')).catch(() => {});
  return { root, env };
}

test('gitVisibleFiles honours .gitignore, nested ignores, info/exclude and core.excludesFile', async (t) => {
  const { root, env } = await repo(t);
  const files = (await gitVisibleFiles(root, { includeHidden: true, env })).map((f) => f.relative.split(path.sep).join('/'));
  assert.deepEqual(files.filter((f) => !f.startsWith('.git')), ['.env', 'src/.gitignore', 'src/app.js', 'tracked.txt', 'untracked.txt']);
  assert.ok(files.includes('.gitignore'));
  // The caller's skip hook (sensitive files) and hidden filtering apply too.
  const plain = (await gitVisibleFiles(root, { env, skip: (rel) => rel === '.env' })).map((f) => f.relative.split(path.sep).join('/'));
  assert.deepEqual(plain, ['src/app.js', 'tracked.txt', 'untracked.txt']);
});

test('an explicitly targeted ignored folder, a non-repository and the opt-out fall back to a plain walk', async (t) => {
  const { root, env } = await repo(t);
  assert.equal(await gitVisibleFiles(path.join(root, 'out'), { env }), null);
  assert.equal(await gitVisibleFiles(root, { env: { ...env, OASIS_RESPECT_GITIGNORE: '0' } }), null);
  assert.equal(gitignoreRespected({ OASIS_RESPECT_GITIGNORE: 'off' }), false);
  assert.equal(gitignoreRespected({}), true);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-nogit-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'a.txt'), 'a');
  assert.equal(await gitVisibleFiles(outside, { env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(outside) } }), null);
});

test('walkFiles, list_files and the built-in grep fallback skip git-ignored files', async (t) => {
  const { root, env } = await repo(t);
  const prev = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = env.HOME; process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const walked = (await walkFiles(root, { includeHidden: true })).map((f) => f.relative.split(path.sep).join('/'));
  assert.ok(!walked.some((f) => /out\/|gen\/|\.log$|local-only|from-global|gone|\.env$|link\.txt/.test(f)), walked.join(','));
  assert.ok(walked.includes('src/app.js') && walked.includes('untracked.txt'));
  const listed = await listWorkspaceFiles(root, {});
  assert.deepEqual(listed.files, ['src/app.js', 'tracked.txt', 'untracked.txt']);
  const grep = await grepWorkspace(root, { pattern: 'needle', output_mode: 'files_with_matches' }, { forceFallback: true });
  assert.deepEqual(grep.results.sort(), ['src/app.js', 'tracked.txt', 'untracked.txt']);
  // Searching inside the ignored folder on purpose still works.
  const inOut = await grepWorkspace(root, { pattern: 'needle', path: 'out', output_mode: 'files_with_matches' }, { forceFallback: true });
  assert.deepEqual(inOut.results, ['out/bundle.js']);
  // Opting out restores the old walk.
  const raw = (await walkFiles(root, { includeHidden: true, respectGitignore: false })).map((f) => f.relative.split(path.sep).join('/'));
  assert.ok(raw.includes('out/bundle.js') && raw.includes('debug.log'));
});
