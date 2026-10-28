// `oasis update`: find out whether a newer Oasis is on GitHub main and install it.
// Works for git checkouts (fast-forward pull) and for npm installs from git
// (npm records the installed commit in its global tree).
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
export const UPDATE_REPO = 'gtxnrg-ship-it/oasis';
export const INSTALL_SPEC = 'git+https://github.com/gtxnrg-ship-it/Oasis.git#main';

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { timeout: options.timeout || 30000, maxBuffer: 8 * 1024 * 1024, cwd: options.cwd, env: options.env || process.env });
  return stdout.trim();
}

export async function latestMainCommit(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const response = await fetchImpl('https://api.github.com/repos/' + UPDATE_REPO + '/commits/main', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'oasis-update' },
    signal: AbortSignal.timeout(options.timeoutMs || 15000)
  });
  if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status + ' while checking for updates.');
  const data = await response.json();
  const sha = String(data && data.sha || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub did not return a commit id.');
  const message = String(data.commit && data.commit.message || '').split('\n')[0].slice(0, 160);
  const date = String(data.commit && data.commit.committer && data.commit.committer.date || '');
  return { sha, message, date };
}

// Returns { kind: 'git' | 'npm' | 'unknown', commit, root }.
export async function installedVersion(appRoot, options = {}) {
  const exec = options.exec || run;
  try {
    await access(path.join(appRoot, '.git'));
    const commit = await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot });
    const dirty = await exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: appRoot }).catch(() => '');
    return { kind: 'git', commit, dirty: Boolean(dirty), root: appRoot };
  } catch {}
  try {
    const tree = JSON.parse(await exec('npm', ['ls', '-g', 'oasis-oss', '--json', '--long'], {}));
    const entry = tree && tree.dependencies && tree.dependencies['oasis-oss'];
    const resolved = String(entry && (entry.resolved || entry.version) || '');
    const match = resolved.match(/#([0-9a-f]{40})\b/);
    if (match) return { kind: 'npm', commit: match[1], root: appRoot };
    if (entry) return { kind: 'npm', commit: '', root: appRoot };
  } catch {}
  return { kind: 'unknown', commit: '', root: appRoot };
}

export function updatePlan(installed, latest) {
  if (installed.commit && installed.commit === latest.sha) return { upToDate: true };
  if (installed.kind === 'git') {
    if (installed.dirty) return { upToDate: false, blocked: 'Your Oasis checkout has uncommitted changes; commit or stash them, then run git pull.' };
    return { upToDate: false, command: 'git', args: ['-C', installed.root, 'pull', '--ff-only', 'origin', 'main'] };
  }
  return { upToDate: false, command: 'npm', args: ['install', '-g', INSTALL_SPEC] };
}

export function describeUpdate(installed, latest, plan) {
  const lines = [];
  lines.push('Installed: ' + (installed.commit ? installed.commit.slice(0, 7) : 'unknown commit') + ' (' + installed.kind + ' install)');
  lines.push('Latest on main: ' + latest.sha.slice(0, 7) + (latest.message ? ' - ' + latest.message : '') + (latest.date ? ' (' + latest.date.slice(0, 10) + ')' : ''));
  if (plan.upToDate) lines.push('Oasis is up to date.');
  else if (plan.blocked) lines.push(plan.blocked);
  else lines.push('Update with: ' + plan.command + ' ' + plan.args.join(' '));
  return lines.join('\n');
}
