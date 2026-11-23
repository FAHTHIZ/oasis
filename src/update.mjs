// `oasis update`: install the latest stable GitHub release, never moving main.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { fetchLatestRelease, resolveTagCommit } from './github-release.mjs';
import { releaseTarballAssets } from './update-verify.mjs';
import semverParse from 'semver/functions/parse.js';
import semverCompare from 'semver/functions/compare.js';

const execFileAsync = promisify(execFile);
const UPDATE_REPO = 'FAHTHIZ/oasis';
export const INSTALL_SPEC = 'https://github.com/FAHTHIZ/oasis/archive/';
// Stands in for the verified local tarball path in a plan's npm step.
export const VERIFIED_TARBALL = '<verified release tarball>';

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { timeout: options.timeout || 30000, maxBuffer: 8 * 1024 * 1024, cwd: options.cwd, env: options.env || process.env });
  return stdout.trim();
}

export async function latestReleaseCommit(options = {}) {
  // API first (with GH_TOKEN/GITHUB_TOKEN when set); github.com pages when the
  // API is rate limited. See src/github-release.mjs.
  const lookup = { fetchImpl: options.fetch || fetch, env: options.env || process.env, timeoutMs: options.timeoutMs, userAgent: 'oasis-update' };
  const release = await fetchLatestRelease(UPDATE_REPO, lookup);
  const tag = String(release && release.tag_name || '');
  if (!release || release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('GitHub did not return a valid latest stable OASIS release.');
  const sha = await resolveTagCommit(UPDATE_REPO, tag, lookup);
  const releaseName = String(release.name || '').trim();
  const bodyLine = String(release.body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  const message = (releaseName && releaseName !== tag ? releaseName : bodyLine).slice(0, 160);
  const tarball = releaseTarballAssets(release, tag);
  return { sha, tag, message, date: String(release.published_at || ''), ...(tarball ? { tarball } : {}) };
}

// Homebrew installs the CLI formula under <prefix>/Cellar/oasis-cli/<version>/.
// Updating that copy with npm would change files Homebrew owns, so `oasis update`
// hands Homebrew installs to `brew upgrade` instead.
export function isHomebrewInstall(appRoot) {
  return /[\\/]Cellar[\\/]oasis-cli[\\/]/.test(String(appRoot || ''));
}

export async function installedVersion(appRoot, options = {}) {
  const exec = options.exec || run;
  if (isHomebrewInstall(appRoot)) {
    const readPackage = options.readPackage || (async () => JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8')));
    const version = String((await readPackage().catch(() => ({}))).version || '');
    return { kind: 'homebrew', commit: '', version, root: appRoot };
  }
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
    // A verified update installs the release tarball from a local file, so
    // npm records no commit; the package version identifies the release.
    if (entry) return { kind: 'npm', commit: '', version: String(entry.version || ''), root: appRoot, ...(options.npmPrefix ? { npmPrefix: options.npmPrefix } : {}) };
  } catch {}
  return { kind: 'unknown', commit: '', root: appRoot };
}

// A git checkout that already contains the release commit (a clone following
// main) is newer than the release. Checking out the tag would move it back and
// drop every later commit, so report how far ahead it is instead.
export async function gitCommitsAheadOfRelease(installed, latest, options = {}) {
  if (!installed || installed.kind !== 'git' || !installed.commit || !latest || !latest.sha || installed.commit === latest.sha) return null;
  const exec = options.exec || run;
  try {
    await exec('git', ['merge-base', '--is-ancestor', latest.sha, installed.commit], { cwd: installed.root });
  } catch { return null; }
  const count = Number(await exec('git', ['rev-list', '--count', latest.sha + '..' + installed.commit], { cwd: installed.root }).catch(() => ''));
  return Number.isFinite(count) && count > 0 ? count : null;
}

// Whether an npm or Homebrew install already has a later version than the
// release (for example one installed from main), so updating would downgrade it.
function newerThanRelease(installed, latest) {
  const mine = semverParse(String(installed.version || '').trim());
  const theirs = semverParse(String(latest.tag || '').trim().replace(/^v/, ''));
  return Boolean(mine && theirs && semverCompare(mine, theirs) > 0);
}

export function updatePlan(installed, latest) {
  if (installed.commit && installed.commit === latest.sha) return { upToDate: true };
  if (installed.kind === 'git' && installed.aheadOfRelease) return { upToDate: true, ahead: installed.aheadOfRelease };
  if (installed.kind !== 'git' && newerThanRelease(installed, latest)) return { upToDate: true, newer: true };
  if (installed.kind === 'homebrew') {
    if (installed.version && 'v' + installed.version === latest.tag) return { upToDate: true };
    return { upToDate: false, steps: [{ command: 'brew', args: ['upgrade', 'fahthiz/oasis/oasis-cli'] }] };
  }
  if (installed.kind === 'git') {
    if (installed.dirty) return { upToDate: false, blocked: 'Your Oasis checkout has uncommitted changes; commit or stash them, then run oasis update.' };
    return { upToDate: false, steps: [
      { command: 'git', args: ['-C', installed.root, 'fetch', '--no-tags', 'origin', 'refs/tags/' + latest.tag] },
      { command: 'git', args: ['-C', installed.root, 'checkout', '--detach', latest.sha] }
    ] };
  }
  if (installed.kind === 'npm' && !installed.commit && installed.version && 'v' + installed.version === latest.tag) return { upToDate: true };
  // The release's own npm tarball, downloaded and checked (SHA256SUMS,
  // package name and version, provenance) before npm sees it.
  if (latest.tarball) return { upToDate: false, verified: true, steps: [{
    command: 'npm',
    args: ['install', '-g', ...(installed.npmPrefix ? ['--prefix', installed.npmPrefix] : []), VERIFIED_TARBALL]
  }] };
  return { upToDate: false, steps: [{
    command: 'npm',
    args: ['install', '-g', ...(installed.npmPrefix ? ['--prefix', installed.npmPrefix] : []), INSTALL_SPEC + latest.sha + '.tar.gz']
  }] };
}

export function describeUpdate(installed, latest, plan) {
  const lines = [
    'Installed: ' + (installed.commit ? installed.commit.slice(0, 7) : installed.version ? 'v' + installed.version : 'unknown commit') + ' (' + installed.kind + ' install)',
    'Latest stable release: ' + latest.tag + ' (' + latest.sha.slice(0, 7) + ')' + (latest.message ? ' - ' + latest.message : '') + (latest.date ? ' (' + latest.date.slice(0, 10) + ')' : '')
  ];
  if (plan.ahead) lines.push('This checkout already includes ' + latest.tag + ' and is ' + plan.ahead + ' commit' + (plan.ahead === 1 ? '' : 's') + ' newer, so oasis update leaves it alone. To follow main, run: git -C ' + JSON.stringify(installed.root) + ' pull');
  else if (plan.newer) lines.push('Installed v' + installed.version + ' is newer than ' + latest.tag + ', so oasis update leaves it alone instead of downgrading it.');
  else if (plan.upToDate) lines.push('Oasis is up to date.');
  else if (plan.blocked) lines.push(plan.blocked);
  else {
    if (plan.verified) lines.push('Update: download ' + latest.tarball.tarball.name + ' from the release, check it against SHA256SUMS, its package version and (with gh) its signed provenance, then install it with:');
    else lines.push('Update with:');
    for (const step of plan.steps || []) lines.push('  ' + step.command + ' ' + step.args.map((arg) => arg === VERIFIED_TARBALL ? arg : JSON.stringify(arg)).join(' '));
    if (!plan.verified && installed.kind !== 'git' && installed.kind !== 'homebrew') lines.push('This release has no npm tarball with SHA256SUMS, so the source archive is installed unchecked.');
  }
  return lines.join('\n');
}
