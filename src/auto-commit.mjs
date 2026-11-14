// Opt-in Aider-style auto-commit: after a turn that changed files, commit
// exactly those paths so every change OASIS makes is its own Git commit.
// Other staged or unstaged work is left alone (git commit --only), Git hooks
// run as usual, and ignored files are never added.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { stripAiAttribution } from './commit-attribution.mjs';
import { endChildInput } from './node-process.mjs';

const TRUE = /^(?:1|true|yes|on)$/i;
const FALSE = /^(?:0|false|no|off)$/i;

export function autoCommitEnabled(session = {}, env = process.env) {
  if (session && typeof session.autoCommit === 'boolean') return session.autoCommit;
  const value = String(env.OASIS_AUTO_COMMIT || '');
  if (TRUE.test(value)) return true;
  if (FALSE.test(value)) return false;
  return Boolean(session && session.settings && session.settings.autoCommit === true);
}

function git(args, cwd, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    endChildInput(child, input);
  });
}

export function commitSubject(prompt = '') {
  const line = String(prompt || '').split(/\r?\n/).map((item) => item.trim()).find(Boolean) || 'changes';
  const clean = line.replace(/\s+/g, ' ').replace(/^[/#!]+/, '').trim() || 'changes';
  const subject = clean.length > 72 ? clean.slice(0, 71).replace(/\s+\S*$/, '') + '…' : clean;
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

export async function autoCommitTurn({ root, paths = [], prompt = '' } = {}) {
  if (!paths.length) return { skipped: 'no files changed' };
  const top = await git(['rev-parse', '--show-toplevel'], root);
  if (top.code !== 0) return { skipped: 'not a Git repository' };
  const repo = top.stdout.trim();
  const gitDir = (await git(['rev-parse', '--absolute-git-dir'], root)).stdout.trim();
  if (gitDir && ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some((name) => existsSync(path.join(gitDir, name)))) {
    return { skipped: 'a merge, rebase or cherry-pick is in progress' };
  }
  const relative = [...new Set(paths.map((item) => path.relative(repo, path.resolve(root, item))))]
    .filter((item) => item && !item.startsWith('..') && !path.isAbsolute(item));
  if (!relative.length) return { skipped: 'the changed files are outside the repository' };
  const ignored = await git(['check-ignore', '--stdin'], repo, { input: relative.join('\n') + '\n' });
  const ignoredSet = new Set(ignored.stdout.split('\n').map((item) => item.trim()).filter(Boolean));
  const files = relative.filter((item) => !ignoredSet.has(item));
  if (!files.length) return { skipped: 'the changed files are ignored by Git' };
  const added = await git(['add', '-A', '--', ...files], repo);
  if (added.code !== 0) return { error: 'git add failed: ' + (added.stderr.trim().split('\n')[0] || 'exit ' + added.code) };
  const pending = await git(['diff', '--cached', '--name-only', '--', ...files], repo);
  const changed = pending.stdout.split('\n').map((item) => item.trim()).filter(Boolean);
  if (!changed.length) return { skipped: 'the files match the last commit' };
  const subject = commitSubject(prompt);
  const body = 'Files changed:\n' + changed.map((item) => '- ' + item).join('\n');
  // The message goes in on stdin with --cleanup=strip so a prepare-commit-msg
  // or template cannot reintroduce credit lines; the user's own identity
  // (git config) is the author.
  const commit = await git(['commit', '--only', '--cleanup=strip', '-F', '-', '--', ...changed], repo, { input: stripAiAttribution(subject + '\n\n' + body) + '\n' });
  if (commit.code !== 0) {
    const reason = (commit.stderr.trim() || commit.stdout.trim()).split('\n').filter(Boolean).slice(-1)[0] || 'exit ' + commit.code;
    return { error: 'git commit failed (the files are staged): ' + reason };
  }
  const sha = (await git(['rev-parse', '--short', 'HEAD'], repo)).stdout.trim();
  return { committed: sha, subject, files: changed };
}

export function describeAutoCommit(result) {
  if (!result) return '';
  if (result.committed) return 'Committed ' + result.committed + ' ' + result.subject + ' (' + result.files.length + ' file' + (result.files.length === 1 ? '' : 's') + '). Undo with git reset --soft HEAD~1.';
  if (result.error) return 'Auto-commit: ' + result.error;
  return '';
}
