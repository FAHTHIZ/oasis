// Git worktree isolation for subagents. A subagent launched with
// isolation: "worktree" works on its own branch in .oasis/worktrees/<name>,
// so several agents can edit in parallel without touching the user's checkout.
// Afterwards its changes are committed on that branch for review and merge.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, rm } from 'node:fs/promises';

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
  // Cloud coding tasks need a reproducible base. Never silently omit dirty user
  // changes when branching from HEAD; callers can explicitly commit or stash first.
  if (options.requireClean) {
    const changes = await git(root, ['status', '--porcelain', '--untracked-files=all'], env);
    if (changes) throw new Error('Isolated task mode requires a clean Git workspace. Commit or stash your existing changes first; Oasis did not create a worktree.');
  }
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

const SENSITIVE_PATH = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|p12|pfx|keystore|jks))$/i;
const SECRET_VALUE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b|\bAKIA[0-9A-Z]{16}\b|\bAuthorization:\s*Bearer\s+\S{16,}/i;

async function inspectWorktreeSecrets(worktree, options = {}) {
  const env = options.env || process.env;
  const changed = await git(worktree.path, ['diff', '--name-only', '-z', worktree.base, '--'], env);
  const untracked = await git(worktree.path, ['ls-files', '--others', '--exclude-standard', '-z'], env);
  const files = [...new Set([...changed.split('\0'), ...untracked.split('\0')].filter(Boolean))];
  if (files.length > 256) throw new Error('Automatic task commit blocked: the change contains more than 256 files, exceeding the safety scan limit. Inspect the worktree manually.');
  const sensitivePaths = files.filter((file) => SENSITIVE_PATH.test(path.posix.basename(file.replace(/\\/g, '/'))));
  if (sensitivePaths.length) {
    throw new Error('Automatic task commit blocked because potentially sensitive file paths were changed: ' + sensitivePaths.slice(0, 20).join(', ') + '. The worktree was retained; inspect the diff and decide what to keep before committing.');
  }
  let scannedBytes = 0;
  const possibleSecrets = [];
  for (const file of files) {
    const absolute = path.resolve(worktree.path, file);
    if (!absolute.startsWith(path.resolve(worktree.path) + path.sep)) continue;
    const info = await lstat(absolute).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > 2 * 1024 * 1024) throw new Error('Automatic task commit blocked: a changed file exceeded the 2 MB secret-scan limit (' + file + '). Inspect the worktree manually.');
    scannedBytes += info.size;
    if (scannedBytes > 8 * 1024 * 1024) throw new Error('Automatic task commit blocked: the changed files exceeded the safety scan byte limit. Inspect the worktree manually.');
    const contents = await readFile(absolute).catch(() => null);
    if (!contents) continue;
    // Credential formats are ASCII; scan the raw byte values too, rather than
    // skipping binary files that might contain an embedded token.
    if (SECRET_VALUE.test(contents.toString('latin1'))) possibleSecrets.push(file);
  }
  if (possibleSecrets.length) {
    throw new Error('Automatic task commit blocked because possible credentials were detected in: ' + possibleSecrets.slice(0, 20).join(', ') + '. The worktree was retained; review the content locally before staging or committing.');
  }
}

// Commit the subagent's work on its branch. Unchanged worktrees are removed entirely.
export async function finishWorktree(root, worktree, options = {}) {
  const env = options.env || process.env;
  const status = await git(worktree.path, ['status', '--porcelain', '--untracked-files=all'], env).catch(() => '');
  if (!status) {
    await removeWorktree(root, worktree, { env, deleteBranch: true });
    return { changed: false, branch: worktree.branch, removed: true };
  }
  if (options.blockSecrets) await inspectWorktreeSecrets(worktree, { env });
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

export async function readWorktreeDiff(root, baseCommit, headCommit, options = {}) {
  const env = options.env || process.env;
  if (!/^[a-f0-9]{40}$/i.test(String(baseCommit || ''))) throw new Error('A full base commit SHA is required to read an isolated task diff.');
  if (!/^[a-f0-9]{7,40}$/i.test(String(headCommit || ''))) throw new Error('A valid task commit SHA is required to read an isolated task diff.');
  const maxChars = Math.max(1000, Math.min(250000, Number(options.maxChars) || 180000));
  // Disable external diff drivers and text conversion hooks: a review endpoint must
  // never execute repository-provided diff helpers.
  const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', baseCommit, headCommit, '--'], env, 30000);
  return { diff: diff.slice(0, maxChars), truncated: diff.length > maxChars };
}

export async function readWorktreeWorkingDiff(worktreeRoot, baseCommit, options = {}) {
  const env = options.env || process.env;
  if (!/^[a-f0-9]{40}$/i.test(String(baseCommit || ''))) throw new Error('A full base commit SHA is required to inspect an interrupted task.');
  const root = path.resolve(worktreeRoot);
  const top = await git(root, ['rev-parse', '--show-toplevel'], env);
  if (path.resolve(top) !== root) throw new Error('The task directory is no longer a Git worktree root.');
  const maxChars = Math.max(1000, Math.min(250000, Number(options.maxChars) || 180000));
  let diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', baseCommit, '--'], env, 30000);
  const listed = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], env, 15000).catch(() => '');
  const untrackedFiles = [];
  let omitted = 0;
  for (const candidate of listed.split('\0').filter(Boolean).slice(0, 100)) {
    const absolute = path.resolve(root, candidate);
    if (path.isAbsolute(candidate) || absolute === root || !absolute.startsWith(root + path.sep)) continue;
    const info = await lstat(absolute).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) continue;
    const label = candidate.split(path.sep).join('/');
    untrackedFiles.push(label);
    if (info.size > 30000) {
      diff += '\n\n# Untracked file omitted from preview (over 30 KB): ' + label;
      omitted++;
      continue;
    }
    const bytes = await readFile(absolute).catch(() => null);
    if (!bytes) continue;
    if (bytes.includes(0)) {
      diff += '\n\n# Binary untracked file omitted from text preview: ' + label;
      omitted++;
      continue;
    }
    const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    diff += '\n\ndiff --git a/' + label + ' b/' + label +
      '\nnew file mode 100644\n--- /dev/null\n+++ b/' + label +
      '\n' + lines.map((line) => '+' + line).join('\n');
  }
  const truncated = diff.length > maxChars;
  if (truncated) diff = diff.slice(0, maxChars);
  return { diff, truncated, untrackedFiles: untrackedFiles.slice(0, 100), omittedUntracked: omitted };
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
