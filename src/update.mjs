// `oasis update`: install the latest stable GitHub release, never moving main.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
export const UPDATE_REPO = 'FAHTHIZ/oasis';
export const INSTALL_SPEC = 'https://github.com/FAHTHIZ/oasis/archive/';

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { timeout: options.timeout || 30000, maxBuffer: 8 * 1024 * 1024, cwd: options.cwd, env: options.env || process.env });
  return stdout.trim();
}

export async function latestReleaseCommit(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const api = 'https://api.github.com/repos/' + UPDATE_REPO;
  const request = () => ({
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'oasis-update' },
    signal: AbortSignal.timeout(options.timeoutMs || 15000)
  });
  const releaseResponse = await fetchImpl(api + '/releases/latest', request());
  if (!releaseResponse.ok) throw new Error('GitHub returned HTTP ' + releaseResponse.status + ' while checking for the latest stable release.');
  const release = await releaseResponse.json();
  const tag = String(release && release.tag_name || '');
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('GitHub did not return a valid latest stable OASIS release.');
  const commitResponse = await fetchImpl(api + '/commits/' + encodeURIComponent(tag), request());
  if (!commitResponse.ok) throw new Error('GitHub returned HTTP ' + commitResponse.status + ' while resolving release ' + tag + '.');
  const commit = await commitResponse.json();
  const sha = String(commit && commit.sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub did not return a valid commit id for release ' + tag + '.');
  const releaseName = String(release.name || '').trim();
  const bodyLine = String(release.body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  const message = (releaseName && releaseName !== tag ? releaseName : bodyLine).slice(0, 160);
  return { sha, tag, message, date: String(release.published_at || '') };
}

export async function installedVersion(appRoot, options = {}) {
  const exec = options.exec || run;
  try {
    await access(path.join(appRoot, '.git'));
    const commit = await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot });
    const dirty = await exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: appRoot }).catch(() => '');
    return { kind: 'git', commit, dirty: Boolean(dirty), root: appRoot };
  } catch {}
  try {
    const npmArgs = ['ls', '-g'];
    if (options.npmPrefix) npmArgs.push('--prefix', options.npmPrefix);
    npmArgs.push('oasis-oss', '--json', '--long');
    const tree = JSON.parse(await exec('npm', npmArgs, {}));
    const entry = tree && tree.dependencies && tree.dependencies['oasis-oss'];
    const resolved = String(entry && (entry.resolved || entry.version) || '');
    const match = resolved.match(/(?:#|\/)([0-9a-f]{40})(?:\.tar\.gz)?\b/);
    if (match) return { kind: 'npm', commit: match[1], root: appRoot, ...(options.npmPrefix ? { npmPrefix: options.npmPrefix } : {}) };
    if (entry) return { kind: 'npm', commit: '', root: appRoot, ...(options.npmPrefix ? { npmPrefix: options.npmPrefix } : {}) };
  } catch {}
  return { kind: 'unknown', commit: '', root: appRoot };
}

export function updatePlan(installed, latest) {
  if (installed.commit && installed.commit === latest.sha) return { upToDate: true };
  if (installed.kind === 'git') {
    if (installed.dirty) return { upToDate: false, blocked: 'Your Oasis checkout has uncommitted changes; commit or stash them, then run oasis update.' };
    return { upToDate: false, steps: [
      { command: 'git', args: ['-C', installed.root, 'fetch', '--no-tags', 'origin', 'refs/tags/' + latest.tag] },
      { command: 'git', args: ['-C', installed.root, 'checkout', '--detach', latest.sha] }
    ] };
  }
  return { upToDate: false, steps: [{
    command: 'npm',
    args: ['install', '-g', ...(installed.npmPrefix ? ['--prefix', installed.npmPrefix] : []), INSTALL_SPEC + latest.sha + '.tar.gz']
  }] };
}

export function describeUpdate(installed, latest, plan) {
  const lines = [
    'Installed: ' + (installed.commit ? installed.commit.slice(0, 7) : 'unknown commit') + ' (' + installed.kind + ' install)',
    'Latest stable release: ' + latest.tag + ' (' + latest.sha.slice(0, 7) + ')' + (latest.message ? ' - ' + latest.message : '') + (latest.date ? ' (' + latest.date.slice(0, 10) + ')' : '')
  ];
  if (plan.upToDate) lines.push('Oasis is up to date.');
  else if (plan.blocked) lines.push(plan.blocked);
  else {
    lines.push('Update with:');
    for (const step of plan.steps || []) lines.push('  ' + step.command + ' ' + step.args.map((arg) => JSON.stringify(arg)).join(' '));
  }
  return lines.join('\n');
}
