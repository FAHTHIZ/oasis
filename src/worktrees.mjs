// Git worktree isolation for subagents. A subagent launched with
// isolation: "worktree" works on its own branch in .oasis/worktrees/<name>,
// so several agents can edit in parallel without touching the user's checkout.
// Afterwards its changes are committed on that branch for review and merge.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
export const WORKTREE_DIR = path.join('.oasis', 'worktrees');

function gitEnv(env = process.env) {
  return { PATH: env.PATH || process.env.PATH, HOME: env.HOME || process.env.HOME, GIT_TERMINAL_PROMPT: '0', LANG: 'C' };
}

async function git(cwd, args, env, timeout = 20000) {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: gitEnv(env) });
  return stdout.trim();
}

export function worktreeSlug(text) {
  return String(text || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
}

// Keep the worktrees out of the parent's git status, grep and search results.
async function excludeWorktreeDir(gitCommonDir) {
  const file = path.join(gitCommonDir, 'info', 'exclude');
  let current = '';
  try { current = await readFile(file, 'utf8'); } catch {}
  if (current.split(/\r?\n/).includes('/.oasis/worktrees/')) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, (current && !current.endsWith('\n') ? '\n' : '') + '/.oasis/worktrees/\n');
}

export async function createWorktree(root, label, options = {}) {
  const env = options.env || process.env;
  let top;
  try { top = await git(root, ['rev-parse', '--show-toplevel'], env); }
  catch { throw new Error('isolation "worktree" needs a git repository. Run git init first, or launch the subagent without isolation.'); }
  if (path.resolve(top) !== path.resolve(root)) throw new Error('isolation "worktree" works only from the repository root (' + top + ').');
  try { await git(root, ['rev-parse', '--verify', 'HEAD'], env); }
  catch { throw new Error('isolation "worktree" needs at least one commit to branch from.'); }
  const commonDir = path.resolve(root, await git(root, ['rev-parse', '--git-common-dir'], env));
  await excludeWorktreeDir(commonDir);
  const name = worktreeSlug(label) + '-' + randomBytes(3).toString('hex');
  const branch = 'oasis/' + name;
  const relative = path.join(WORKTREE_DIR, name);
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await git(root, ['worktree', 'add', '-b', branch, absolute, 'HEAD'], env, 60000);
  const base = await git(absolute, ['rev-parse', 'HEAD'], env);
  return { name, branch, path: absolute, relative: relative.split(path.sep).join('/'), base };
}

// Commit the subagent's work on its branch. Unchanged worktrees are removed entirely.
export async function finishWorktree(root, worktree, options = {}) {
  const env = options.env || process.env;
  const status = await git(worktree.path, ['status', '--porcelain', '--untracked-files=all'], env).catch(() => '');
  if (!status) {
    await removeWorktree(root, worktree, { env, deleteBranch: true });
    return { changed: false, branch: worktree.branch, removed: true };
  }
  await git(worktree.path, ['add', '-A'], env);
  const identity = [];
  const email = await git(worktree.path, ['config', 'user.email'], env).catch(() => '');
  if (!email) identity.push('-c', 'user.name=Oasis subagent', '-c', 'user.email=oasis@localhost');
  // --no-verify: repository hooks run arbitrary code; the user reviews the branch instead.
  await git(worktree.path, [...identity, 'commit', '--no-verify', '-q', '-m', 'Oasis subagent: ' + String(options.message || worktree.name).slice(0, 200)], env, 60000);
  const commit = await git(worktree.path, ['rev-parse', '--short', 'HEAD'], env);
  const stat = await git(worktree.path, ['diff', '--stat', worktree.base, 'HEAD'], env).catch(() => '');
  const files = (await git(worktree.path, ['diff', '--name-only', worktree.base, 'HEAD'], env).catch(() => '')).split('\n').filter(Boolean);
  return {
    changed: true,
    branch: worktree.branch,
    path: worktree.relative,
    commit,
    files: files.slice(0, 200),
    diffStat: stat.slice(-4000),
    merge: 'git merge ' + worktree.branch + '   (or review with: git diff HEAD...' + worktree.branch + ')',
    cleanup: 'git worktree remove ' + worktree.relative + ' && git branch -D ' + worktree.branch
  };
}

export async function removeWorktree(root, worktree, options = {}) {
  const env = options.env || process.env;
  await git(root, ['worktree', 'remove', '--force', worktree.path], env).catch(async () => {
    await rm(worktree.path, { recursive: true, force: true });
    await git(root, ['worktree', 'prune'], env).catch(() => {});
  });
  if (options.deleteBranch) await git(root, ['branch', '-D', worktree.branch], env).catch(() => {});
}

export async function listWorktrees(root, options = {}) {
  const env = options.env || process.env;
  const out = await git(root, ['worktree', 'list', '--porcelain'], env).catch(() => '');
  const items = [];
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9) }; items.push(current); }
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  const prefix = path.join(path.resolve(root), WORKTREE_DIR) + path.sep;
  return items.filter((item) => path.resolve(item.path).startsWith(prefix)).map((item) => ({ ...item, relative: path.relative(root, item.path).split(path.sep).join('/') }));
}
