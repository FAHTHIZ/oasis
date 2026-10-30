// Git worktree isolation for subagents. A subagent launched with
// isolation: "worktree" works on its own branch in .oasis/worktrees/<name>,
// so several agents can edit in parallel without touching the user's checkout.
// Afterwards its changes are committed on that branch for review and merge.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import { randomBytes } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runHooks, hasHooks } from './hooks.mjs';

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_KILL_GRACE_MS = 750;
export const WORKTREE_DIR = path.join('.oasis', 'worktrees');

// Run no-shell child processes with bounded output and process-tree cleanup.
// Exported for focused lifecycle regression tests; production callers pass Git.
export function runWorktreeCommand(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const timeoutMs = Number.isSafeInteger(options.timeout) && options.timeout > 0 ? options.timeout : 20000;
  const signal = options.signal;
  return new Promise((resolve) => {
    let child;
    let timer = null;
    let killTimer = null;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let interrupted = false;
    let timedOut = false;
    let cancelled = false;
    let outputExceeded = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Keep escalation armed after interruption: a leader can exit before a
      // descendant that inherited a pipe or ignored SIGTERM.
      if (!interrupted && killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', abort);
      resolve({ ...result, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const terminate = (kind) => {
      if (settled || interrupted) return;
      interrupted = true;
      timedOut = kind === 'timeout';
      cancelled = kind === 'cancel';
      outputExceeded = kind === 'output';
      signalProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killTimer = null;
        signalProcessTree(child, 'SIGKILL');
      }, GIT_KILL_GRACE_MS);
      killTimer.unref?.();
      if (timedOut) {
        stderr = (stderr + '\\nGit command timed out after ' + timeoutMs + 'ms.').trim();
        finish({ exitCode: 124, timedOut: true });
      } else if (cancelled) {
        stderr = (stderr + '\\nGit command was cancelled.').trim();
        finish({ exitCode: 130, cancelled: true });
      } else {
        stderr = (stderr + '\\nGit command output exceeded 4 MiB.').trim();
        finish({ exitCode: 125, outputExceeded: true });
      }
    };
    const collect = (stream, chunk) => {
      if (settled) return;
      const isStdout = stream === 'stdout';
      const currentBytes = isStdout ? stdoutBytes : stderrBytes;
      if (currentBytes + chunk.byteLength > MAX_GIT_OUTPUT_BYTES) {
        const remaining = Math.max(0, MAX_GIT_OUTPUT_BYTES - currentBytes);
        const text = remaining ? chunk.subarray(0, remaining).toString('utf8') : '';
        if (isStdout) { stdout += text; stdoutBytes += remaining; }
        else { stderr += text; stderrBytes += remaining; }
        terminate('output');
        return;
      }
      if (isStdout) { stdout += chunk.toString('utf8'); stdoutBytes += chunk.byteLength; }
      else { stderr += chunk.toString('utf8'); stderrBytes += chunk.byteLength; }
    };

    try {
      child = spawn(command, args, {
        cwd, env, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...processTreeSpawnOptions()
      });
    } catch (error) {
      finish({ exitCode: 127, error: error.message, errorCode: error.code });
      return;
    }
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', (error) => finish({
      exitCode: 127, error: error.message, errorCode: error.code,
      ...(timedOut ? { timedOut: true } : {}),
      ...(cancelled ? { cancelled: true } : {})
    }));
    child.on('close', (code) => finish({
      exitCode: timedOut ? 124 : cancelled ? 130 : outputExceeded ? 125 : (code ?? 1),
      ...(timedOut ? { timedOut: true } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      ...(outputExceeded ? { outputExceeded: true } : {})
    }));
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    function abort() { terminate('cancel'); }
  });
}

function within(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// The worktree destination is inside a repository that may be untrusted. Never
// follow a pre-existing .oasis or .oasis/worktrees symlink outside the checkout.
async function ensureWorktreeParent(root) {
  const rootReal = await realpath(root);
  let current = rootReal;
  for (const segment of ['.oasis', 'worktrees']) {
    current = path.join(current, segment);
    try { await mkdir(current, { recursive: false, mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Refusing to create an isolated worktree through a non-directory or symbolic-link path: ' + current);
    }
    const resolved = await realpath(current);
    if (!within(rootReal, resolved)) throw new Error('Worktree destination escapes the repository through a symbolic link: ' + current);
  }
  return current;
}

function gitEnv(env = process.env) {
  return { PATH: env.PATH || process.env.PATH, HOME: env.HOME || process.env.HOME, GIT_TERMINAL_PROMPT: '0', LANG: 'C' };
}

async function git(cwd, args, env, timeout = 20000) {
  const result = await runWorktreeCommand('git', args, { cwd, timeout, env: gitEnv(env) });
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.error || ('Git ' + String(args[0] || 'command') + ' exited with code ' + result.exitCode + '.');
    const error = new Error(detail);
    error.code = result.timedOut ? 'ETIMEDOUT' : result.errorCode || result.exitCode;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    if (result.timedOut) error.timedOut = true;
    if (result.cancelled) error.cancelled = true;
    throw error;
  }
  return result.stdout.trim();
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

// WorktreeCreate / WorktreeRemove hooks replace git entirely (for other VCSs or custom
// layouts): the create hook prints the new directory, the remove hook deletes it.
async function createHookWorktree(root, label, options) {
  const name = worktreeSlug(label) + '-' + randomBytes(3).toString('hex');
  const result = await runHooks('WorktreeCreate', { session_id: options.sessionId || 'unsaved', name }, options.hookOptions);
  const reason = result.messages.find((message) => /^WorktreeCreate hook failed/.test(message));
  if (result.failed || !result.worktreePath) throw new Error(reason || 'WorktreeCreate hook did not print a worktree path.');
  const raw = result.worktreePath;
  if (path.isAbsolute(raw) && raw.split(/[\\/]/).some((part) => part === '.' || part === '..')) throw new Error('WorktreeCreate hook returned a path with . or .. segments: ' + raw);
  const absolute = path.resolve(root, raw);
  let info = null;
  try { info = await stat(absolute); } catch {}
  if (!info || !info.isDirectory()) throw new Error('WorktreeCreate hook returned ' + absolute + ', which is not a directory.');
  const relative = path.relative(root, absolute);
  return { name, branch: null, path: absolute, relative: (relative && !relative.startsWith('..') ? relative : absolute).split(path.sep).join('/'), base: null, hook: true };
}

export async function createWorktree(root, label, options = {}) {
  const env = options.env || process.env;
  if (options.hookOptions && hasHooks(options.hookOptions.hooks, 'WorktreeCreate')) return createHookWorktree(root, label, options);
  let top;
  try { top = await git(root, ['rev-parse', '--show-toplevel'], env); }
  catch { throw new Error('isolation "worktree" needs a git repository. Run git init first, or launch the subagent without isolation.'); }
  if (path.resolve(top) !== path.resolve(root)) throw new Error('isolation "worktree" works only from the repository root (' + top + ').');
  try { await git(root, ['rev-parse', '--verify', 'HEAD'], env); }
  catch { throw new Error('isolation "worktree" needs at least one commit to branch from.'); }
  if (options.requireClean) {
    const changes = await git(root, ['status', '--porcelain', '--untracked-files=all'], env);
    if (changes) throw new Error('Isolated task mode requires a clean Git workspace. Commit or stash your existing changes first; OASIS did not create a worktree.');
  }
  const commonDir = path.resolve(root, await git(root, ['rev-parse', '--git-common-dir'], env));
  await excludeWorktreeDir(commonDir);
  const name = worktreeSlug(label) + '-' + randomBytes(3).toString('hex');
  const branch = 'oasis/' + name;
  const relative = path.join(WORKTREE_DIR, name);
  const worktreeParent = await ensureWorktreeParent(root);
  const absolute = path.join(worktreeParent, name);
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
  if (files.length > 256) throw new Error('Automatic task commit blocked: more than 256 changed files exceed the safety scan limit. Inspect the worktree manually.');
  const sensitivePaths = files.filter((file) => SENSITIVE_PATH.test(path.posix.basename(file.replace(/\\/g, '/'))));
  if (sensitivePaths.length) {
    throw new Error('Automatic task commit blocked because potentially sensitive file paths were changed: ' + sensitivePaths.slice(0, 20).join(', ') + '. The worktree was retained for review.');
  }
  let scannedBytes = 0;
  const possibleSecrets = [];
  for (const file of files) {
    const absolute = path.resolve(worktree.path, file);
    if (!absolute.startsWith(path.resolve(worktree.path) + path.sep)) continue;
    const info = await lstat(absolute).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > 2 * 1024 * 1024) throw new Error('Automatic task commit blocked: changed file exceeds the 2 MB secret-scan limit (' + file + '). Inspect the worktree manually.');
    scannedBytes += info.size;
    if (scannedBytes > 8 * 1024 * 1024) throw new Error('Automatic task commit blocked: changed files exceed the safety scan byte limit. Inspect the worktree manually.');
    const contents = await readFile(absolute).catch(() => null);
    if (!contents) continue;
    if (SECRET_VALUE.test(contents.toString('latin1'))) possibleSecrets.push(file);
  }
  if (possibleSecrets.length) {
    throw new Error('Automatic task commit blocked because possible credentials were detected in: ' + possibleSecrets.slice(0, 20).join(', ') + '. The worktree was retained for review.');
  }
}

// Commit the subagent's work on its branch. Unchanged worktrees are removed entirely.
export async function finishWorktree(root, worktree, options = {}) {
  const env = options.env || process.env;
  if (worktree.hook) return { changed: true, branch: null, path: worktree.path, hook: true, note: 'Created by a WorktreeCreate hook; OASIS leaves it in place without committing or merging.' };
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
  // Unattended worker completion must not execute repository-controlled hook scripts.
  // The caller must opt in explicitly; normal/direct finishWorktree calls run hooks.
  const hookPolicy = options.skipHooks === true ? ['--no-verify'] : [];
  await git(worktree.path, [...identity, 'commit', ...hookPolicy, '-q', '-m', 'Oasis subagent: ' + String(options.message || worktree.name).slice(0, 200)], env, 60000);
  const commitSha = await git(worktree.path, ['rev-parse', 'HEAD'], env);
  const commit = commitSha.slice(0, 7);
  const stat = await git(worktree.path, ['diff', '--stat', worktree.base, 'HEAD'], env).catch(() => '');
  const files = (await git(worktree.path, ['diff', '--name-only', worktree.base, 'HEAD'], env).catch(() => '')).split('\n').filter(Boolean);
  return {
    changed: true,
    branch: worktree.branch,
    path: worktree.relative,
    commit,
    commitSha,
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
    diff += '\n\ndiff --git a/' + label + ' b/' + label +
      '\nnew file mode 100644\n--- /dev/null\n+++ b/' + label +
      '\n' + text.split('\n').map((line) => '+' + line).join('\n');
  }
  const truncated = diff.length > maxChars;
  if (truncated) diff = diff.slice(0, maxChars);
  return { diff, truncated, untrackedFiles: untrackedFiles.slice(0, 100), omittedUntracked: omitted };
}

export async function removeWorktree(root, worktree, options = {}) {
  const env = options.env || process.env;
  if (worktree.hook) {
    // No git fallback: without a WorktreeRemove hook the directory stays.
    if (!options.hookOptions || !hasHooks(options.hookOptions.hooks, 'WorktreeRemove')) return { removed: false, kept: worktree.path };
    const result = await runHooks('WorktreeRemove', { session_id: options.sessionId || 'unsaved', worktree_path: worktree.path }, options.hookOptions);
    if (result.failed && existsSync(worktree.path)) throw new Error('worktree removal failed, kept: ' + worktree.path + (result.messages[0] ? ' (' + result.messages[0] + ')' : ''));
    return { removed: true };
  }
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


function validateOasisBranch(value) {
  const branch = String(value || '').trim();
  if (!/^oasis\/[a-z0-9][a-z0-9-]{0,63}$/.test(branch)) {
    throw new Error('Expected an OASIS-managed branch, such as oasis/fix-tests-a1b2c3.');
  }
  return branch;
}

async function commandResult(root, args, env, timeout = 30000) {
  return runWorktreeCommand('git', args, { cwd: root, env: gitEnv(env), timeout });
}

function nameList(value) {
  return [...new Set(String(value || '').split('\n').map((line) => line.trim()).filter(Boolean))].sort();
}

/**
 * Return true only when a worker commit is already an ancestor of the main checkout.
 * Require a full SHA so stored task metadata cannot accidentally match an ambiguous short hash.
 */
export async function isCommitIntegrated(root, commitValue, options = {}) {
  const commit = String(commitValue || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) return false;
  const env = options.env || process.env;
  try {
    await git(root, ['rev-parse', '--verify', commit + '^{commit}'], env);
    await git(root, ['merge-base', '--is-ancestor', commit, 'HEAD'], env);
    return true;
  } catch {
    return false;
  }
}

/** Inspect an attached OASIS worktree without changing either checkout. */
export async function inspectWorktree(root, branchValue, options = {}) {
  const env = options.env || process.env;
  const branch = validateOasisBranch(branchValue);
  const top = await git(root, ['rev-parse', '--show-toplevel'], env);
  if (path.resolve(top) !== path.resolve(root)) {
    throw new Error('Worktree inspection must run from the repository root (' + top + ').');
  }
  const worktrees = await listWorktrees(root, { env });
  const attached = worktrees.find((item) => item.branch === branch);
  if (!attached) throw new Error('No active OASIS worktree is attached to ' + branch + '.');
  const head = await git(root, ['rev-parse', 'HEAD'], env);
  const currentBranch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env).catch(() => '');
  const branchHead = await git(root, ['rev-parse', '--verify', 'refs/heads/' + branch + '^{commit}'], env);
  const mergeBase = await git(root, ['merge-base', 'HEAD', branchHead], env);
  const branchFiles = nameList(await git(root, ['diff', '--name-only', mergeBase, branchHead], env));
  const mainFiles = nameList(await git(root, ['diff', '--name-only', mergeBase, 'HEAD'], env));
  const mainStatus = await git(root, ['status', '--porcelain=v1', '--untracked-files=all'], env);
  const agentStatus = await git(attached.path, ['status', '--porcelain=v1', '--untracked-files=all'], env);
  const overlaps = branchFiles.filter((file) => mainFiles.includes(file));
  const preview = await commandResult(root, ['merge-tree', '--write-tree', 'HEAD', branchHead], env);
  const previewText = [preview.stdout, preview.stderr].filter(Boolean).join('\n');
  const previewSupported = preview.exitCode === 0 || (preview.exitCode === 1 && /\bCONFLICT\b/.test(previewText));
  const conflictNames = [...new Set([...previewText.matchAll(/CONFLICT\s+\([^)]*\):\s+Merge conflict in (.+)/g)].map((match) => match[1].trim()))].sort();
  const conflicts = preview.exitCode === 0 ? [] : previewSupported ? (conflictNames.length ? conflictNames : ['Git reports a merge conflict.']) : ['Git merge preview unavailable; merge is disabled.'];
  const cleanMain = !mainStatus;
  const cleanAgent = !agentStatus;
  const canMerge = Boolean(currentBranch) && cleanMain && cleanAgent && previewSupported && preview.exitCode === 0 && overlaps.length === 0;
  const blockedReasons = [];
  if (!currentBranch) blockedReasons.push('The main checkout is detached; switch to a named branch first.');
  if (!cleanMain) blockedReasons.push('The main checkout has uncommitted changes.');
  if (!cleanAgent) blockedReasons.push('The agent worktree has uncommitted changes.');
  if (!previewSupported) blockedReasons.push('Git could not safely preview the merge.');
  else if (conflicts.length) blockedReasons.push('Git predicts conflicts: ' + conflicts.join(', '));
  if (overlaps.length) blockedReasons.push('Both branches changed: ' + overlaps.join(', ') + '. Review these paths before explicitly allowing overlap.');
  return {
    ok: true, branch, worktree_path: attached.relative, current_branch: currentBranch || null,
    head, branch_head: branchHead, merge_base: mergeBase, branch_files: branchFiles,
    main_changed_files: mainFiles, overlapping_files: overlaps, merge_conflicts: conflicts,
    merge_preview_supported: previewSupported, main_worktree_clean: cleanMain,
    agent_worktree_clean: cleanAgent, can_merge: canMerge, blocked_reasons: blockedReasons,
    preview: previewText.slice(0, 5000)
  };
}

/** Integrate a reviewed worktree only after preflight and user approval. */
export async function mergeWorktree(root, branchValue, options = {}) {
  const env = options.env || process.env;
  const branch = validateOasisBranch(branchValue);
  const inspection = await inspectWorktree(root, branch, { env });
  if (options.expectedHead && inspection.head !== options.expectedHead) throw new Error('The main branch changed after review; inspect again.');
  if (options.expectedBranchHead && inspection.branch_head !== options.expectedBranchHead) throw new Error('The agent branch changed after review; inspect again.');
  if (!inspection.main_worktree_clean) throw new Error('Merge blocked: the main checkout has uncommitted changes.');
  if (!inspection.agent_worktree_clean) throw new Error('Merge blocked: the agent worktree has uncommitted changes.');
  if (!inspection.current_branch) throw new Error('Merge blocked: the main checkout is detached.');
  if (!inspection.merge_preview_supported) throw new Error('Merge blocked: Git could not safely preview the merge.');
  if (inspection.merge_conflicts.length) throw new Error('Merge blocked because Git predicts conflicts: ' + inspection.merge_conflicts.join(', '));
  if (inspection.overlapping_files.length && options.allowOverlaps !== true) {
    throw new Error('Merge blocked because both branches changed the same files: ' + inspection.overlapping_files.join(', ') + '. Review and explicitly allow overlap before retrying.');
  }
  const latestHead = await git(root, ['rev-parse', 'HEAD'], env);
  const latestStatus = await git(root, ['status', '--porcelain=v1', '--untracked-files=all'], env);
  if (latestHead !== inspection.head || latestStatus) throw new Error('The main checkout changed during merge preparation; inspect again.');
  const result = await commandResult(root, ['merge', '--no-ff', '--no-edit', '-m', 'Merge OASIS worktree: ' + branch, inspection.branch_head], env, 60000);
  if (result.exitCode !== 0) {
    const mergeHead = await commandResult(root, ['rev-parse', '--verify', 'MERGE_HEAD'], env);
    if (mergeHead.exitCode === 0) await commandResult(root, ['merge', '--abort'], env, 30000);
    throw new Error('Git merge failed; any in-progress merge was aborted. ' + (result.stderr || result.stdout || 'No details available.').slice(0, 2000));
  }
  return {
    ok: true, merged: true, branch, target_branch: inspection.current_branch,
    commit: await git(root, ['rev-parse', 'HEAD'], env), files: inspection.branch_files,
    message: 'Merged ' + branch + ' into ' + inspection.current_branch + '. The source worktree was preserved for review and cleanup.'
  };
}
