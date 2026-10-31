// Git safety snapshots. Commands such as `git checkout .`, `git restore f`,
// `git stash drop` or `git switch --discard-changes` throw away uncommitted
// work with no undo — a frequent coding-agent horror story. Before such a
// command runs, the whole working tree (tracked + untracked, honoring
// .gitignore) is written to a commit under refs/oasis/safety/ using a
// temporary index, so the user's index, stash and branch are untouched.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SHELL_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;

function tokens(segment) {
  return String(segment || '').trim().split(/\s+/).filter(Boolean).map((part) => part.replace(/^['"]|['"]$/g, ''));
}

// Returns a short reason when argv (git subcommand + args) discards local work.
export function discardReason(args) {
  const list = (args || []).map(String);
  // Skip global options such as -C dir / --git-dir=x to find the subcommand.
  let index = 0;
  while (index < list.length && list[index].startsWith('-')) index += (list[index] === '-C' || list[index] === '-c') ? 2 : 1;
  const sub = list[index];
  const rest = list.slice(index + 1);
  const restOpts = new Set(rest.filter((arg) => arg.startsWith('-')));
  const paths = rest.filter((arg) => !arg.startsWith('-'));
  if (!sub) return '';
  if (sub === 'reset' && (restOpts.has('--hard') || restOpts.has('--merge') || restOpts.has('--keep'))) return 'git reset ' + [...restOpts].join(' ');
  if (sub === 'checkout' && (restOpts.has('-f') || restOpts.has('--force') || rest.includes('--') || paths.includes('.') || paths.some((item) => /[*/.]/.test(item) && !/^[\w./-]+\.\.[\w./-]+$/.test(item)))) return 'git checkout discarding working-tree changes';
  if (sub === 'restore' && !(restOpts.has('--staged') && !restOpts.has('--worktree') && !restOpts.has('-W'))) return 'git restore';
  if (sub === 'switch' && (restOpts.has('-f') || restOpts.has('--force') || restOpts.has('--discard-changes'))) return 'git switch --discard-changes';
  if (sub === 'clean' && [...restOpts].some((arg) => arg === '--force' || /^-[a-z]*f/i.test(arg))) return 'git clean';
  if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) return 'git stash ' + rest[0];
  return '';
}

// File deletions through the shell bypass OASIS checkpoints (/rewind), so they
// get the same snapshot. Only the program name matters here.
const PREFIX_WRAPPERS = new Set(['sudo', 'doas', 'command', 'time', 'nice', 'nohup', 'xargs', 'env', 'exec']);
function programIndex(parts) {
  let index = 0;
  while (index < parts.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[index]) || PREFIX_WRAPPERS.has(path.basename(parts[index])) || (index > 0 && parts[index].startsWith('-') && PREFIX_WRAPPERS.has(path.basename(parts[index - 1]))))) index++;
  return index;
}

function deleteReason(parts) {
  const first = programIndex(parts);
  const at = /^(?:.*\/)?(?:rm|unlink|rmdir|shred)$/.test(parts[first] || '') ? first : -1;
  if (at !== -1 && (parts.slice(at + 1).some((part) => !part.startsWith('-')) || parts.slice(0, at).some((part) => path.basename(part) === 'xargs'))) return path.basename(parts[at]) + ' ' + parts.slice(at + 1).join(' ').slice(0, 120);
  const find = parts[first] === 'find' || String(parts[first] || '').endsWith('/find') ? first : -1;
  if (find !== -1 && parts.slice(find + 1).includes('-delete')) return 'find -delete';
  return '';
}

// Finds a command that discards or deletes local work, in argv form or a shell string.
export function discardingGitCommand(command, args) {
  const base = path.basename(String(command || ''));
  if (Array.isArray(args) && base === 'git') return discardReason(args) || (String(args.find((arg) => !String(arg).startsWith('-')) || '') === 'rm' ? 'git rm' : '');
  if (Array.isArray(args) && args.length && base !== 'sh' && base !== 'bash' && base !== 'zsh') return deleteReason([command, ...args.map(String)]);
  const text = Array.isArray(args) && args.length ? args.map(String).join(' ') : String(command || '');
  for (const segment of text.split(SHELL_SPLIT)) {
    const parts = tokens(segment);
    const at = parts.findIndex((part) => part === 'git' || part.endsWith('/git'));
    if (at !== -1) {
      const reason = discardReason(parts.slice(at + 1)) || (parts.slice(at + 1).find((part) => !part.startsWith('-')) === 'rm' ? 'git rm' : '');
      if (reason) return reason;
      continue;
    }
    const reason = deleteReason(parts);
    if (reason) return reason;
  }
  return '';
}

function git(cwd, args, env = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

// Writes the snapshot. Returns { ref, commit, restore } or null when there is
// nothing to protect (not a repo, clean tree with no stash at risk).
export async function snapshotWorkingTree(root, reason, { now = Date.now() } = {}) {
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout) return null;
  const cwd = top.stdout;
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=normal']);
  const stashes = /stash (drop|clear)/.test(reason) ? (await git(cwd, ['stash', 'list', '--format=%H'])).stdout.split('\n').filter(Boolean) : [];
  if (!status.stdout && !stashes.length) return null;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const ref = 'refs/oasis/safety/' + stamp;
  let commit = '';
  if (status.stdout) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-git-safety-'));
    try {
      const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
      const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
      if (head.ok) await git(cwd, ['read-tree', 'HEAD'], env);
      const added = await git(cwd, ['add', '-A', '--', '.'], env);
      if (!added.ok) return null;
      const tree = await git(cwd, ['write-tree'], env);
      if (!tree.ok) return null;
      const message = 'OASIS safety snapshot before: ' + reason;
      const made = await git(cwd, ['commit-tree', tree.stdout, ...(head.ok ? ['-p', head.stdout] : []), '-m', message], { GIT_AUTHOR_NAME: 'OASIS', GIT_AUTHOR_EMAIL: 'oasis@localhost', GIT_COMMITTER_NAME: 'OASIS', GIT_COMMITTER_EMAIL: 'oasis@localhost' });
      if (!made.ok) return null;
      commit = made.stdout;
      await git(cwd, ['update-ref', '-m', message, ref, commit]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  stashes.forEach((sha, index) => { git(cwd, ['update-ref', ref + '-stash-' + index, sha]); });
  const restore = commit
    ? 'git restore --source=' + ref + ' --worktree -- .'
    : 'git stash apply ' + (stashes[0] || '');
  return { ref, commit, stashes, restore, cwd };
}

export async function dropSnapshot(snapshot) {
  if (!snapshot) return;
  await git(snapshot.cwd, ['update-ref', '-d', snapshot.ref]);
  for (let index = 0; index < (snapshot.stashes || []).length; index++) await git(snapshot.cwd, ['update-ref', '-d', snapshot.ref + '-stash-' + index]);
}

export function snapshotNote(snapshot) {
  if (!snapshot) return '';
  return 'Safety snapshot: uncommitted work was saved to ' + snapshot.ref + (snapshot.stashes && snapshot.stashes.length ? ' (plus ' + snapshot.stashes.length + ' stash entr' + (snapshot.stashes.length === 1 ? 'y' : 'ies') + ')' : '') +
    ' before this command ran. To bring it back: `' + snapshot.restore + '`. List snapshots with `git for-each-ref refs/oasis/safety`.';
}

export function gitSafetyEnabled(env = process.env) {
  return !/^(0|off|false)$/i.test(String(env.OASIS_GIT_SAFETY ?? ''));
}

// Detects `git commit` in argv or shell form. Returns null or { all } where
// all=true when -a/--all (or -am) stages tracked changes as part of the commit.
export function gitCommitInvocation(command, args) {
  const text = Array.isArray(args) && args.length ? [command, ...args.map(String)].join(' ') : String(command || '');
  for (const segment of text.split(SHELL_SPLIT)) {
    const parts = tokens(segment);
    const at = parts.findIndex((part) => part === 'git' || part.endsWith('/git'));
    if (at === -1) continue;
    const rest = parts.slice(at + 1);
    let index = 0;
    while (index < rest.length && rest[index].startsWith('-')) index += (rest[index] === '-C' || rest[index] === '-c') ? 2 : 1;
    if (rest[index] !== 'commit') continue;
    const flags = rest.slice(index + 1).filter((part) => part.startsWith('-'));
    return { all: flags.some((flag) => flag === '--all' || /^-[a-zA-Z]*a/.test(flag) && !flag.startsWith('--')) };
  }
  return null;
}
