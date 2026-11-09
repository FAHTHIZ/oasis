// Update checks for the CLI and the browser workspace.
//
// Both ask the same question ("is a newer stable release published?") through
// this module. Nothing here installs anything: the user runs `oasis update`.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchLatestRelease, githubApiHeaders } from './github-release.mjs';
// Only the functions used: the semver index loads all 47 of its modules.
import semverParse from 'semver/functions/parse.js';
import semverCompare from 'semver/functions/compare.js';
const semver = { parse: semverParse, compare: semverCompare };

export const UPDATE_REPOSITORY = 'FAHTHIZ/oasis';
export const RELEASES_PAGE = 'https://github.com/' + UPDATE_REPOSITORY + '/releases/latest';
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Semantic version parsing (npm's semver, SemVer 2.0) that tolerates a leading
// "v" and build metadata. Returns null when the value is not a version, so a
// malformed tag can never look "newer".
export function parseVersion(value) {
  const parsed = semver.parse(String(value || '').trim());
  return parsed ? { major: parsed.major, minor: parsed.minor, patch: parsed.patch, prerelease: parsed.prerelease.map(String) } : null;
}

export function compareVersions(a, b) {
  const left = semver.parse(String(a || '').trim());
  const right = semver.parse(String(b || '').trim());
  if (!left || !right) throw new Error('Cannot compare versions ' + JSON.stringify(a) + ' and ' + JSON.stringify(b) + '.');
  return semver.compare(left, right);
}

export function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(.+)$/);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

function githubRequest(options = {}) {
  return {
    headers: githubApiHeaders(options.env, 'oasis-app-update'),
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs || 15000)
  };
}

// Ask GitHub for the newest published release and describe what it means for
// this install. Returns { available, current, latest, asset, ... } and never
// throws for "no update" — only for network or response problems.
export async function checkForAppUpdate({
  currentVersion,
  channel = 'stable',
  kind = 'cli',
  fetchImpl = fetch,
  repository = UPDATE_REPOSITORY,
  timeoutMs,
  env = process.env
} = {}) {
  if (!parseVersion(currentVersion)) throw new Error('The installed OASIS version is not a valid version: ' + JSON.stringify(currentVersion) + '.');
  const api = 'https://api.github.com/repos/' + repository;
  let release;
  if (channel === 'beta') {
    // The beta channel also accepts pre-releases; take the newest by version.
    const response = await fetchImpl(api + '/releases?per_page=20', githubRequest({ timeoutMs, env }));
    if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status + ' while checking for updates.');
    const releases = (await response.json() || []).filter((item) => item && !item.draft && parseVersion(item.tag_name));
    releases.sort((x, y) => compareVersions(y.tag_name, x.tag_name));
    release = releases[0];
  } else {
    // Falls back to github.com pages when the API is rate limited.
    release = await fetchLatestRelease(repository, { fetchImpl, env, timeoutMs, userAgent: 'oasis-app-update' });
    if (release && (release.draft || release.prerelease)) release = null;
  }
  const checkedAt = new Date().toISOString();
  if (!release || !parseVersion(release.tag_name)) {
    return { available: false, current: String(currentVersion), latest: null, checkedAt, kind };
  }
  const latestVersion = String(release.tag_name).replace(/^v/, '');
  const available = compareVersions(latestVersion, currentVersion) > 0;
  return {
    available,
    current: String(currentVersion),
    latest: {
      version: latestVersion,
      tag: String(release.tag_name),
      name: String(release.name || release.tag_name),
      notes: String(release.body || '').slice(0, 4000),
      url: String(release.html_url || RELEASES_PAGE),
      publishedAt: String(release.published_at || ''),
      prerelease: Boolean(release.prerelease)
    },
    kind,
    canInstall: false,
    checkedAt
  };
}

// Small persisted state: when we last checked, what we found, and which version
// the user chose to skip. Corrupt or missing files simply mean "no state".
export async function readUpdateState(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

export async function writeUpdateState(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, filePath);
}

export function updateChecksDisabled(env = process.env, settings = {}) {
  if (/^(1|true|yes)$/i.test(String(env.OASIS_NO_UPDATE_CHECK || ''))) return true;
  if (env.CI && !env.OASIS_UPDATE_CHECK) return true;
  return settings && settings.updateCheck === false;
}

// Should this result be announced? Skipped versions stay quiet until a newer one.
export function shouldNotify(result, state = {}) {
  if (!result || !result.available || !result.latest) return false;
  if (state.skippedVersion && result.latest.version === state.skippedVersion) return false;
  return true;
}

// A cached check, refreshed at most once per interval, shared by all surfaces.
export async function cachedUpdateCheck({ statePath, now = Date.now(), intervalMs = UPDATE_CHECK_INTERVAL_MS, force = false, ...options } = {}) {
  const state = statePath ? await readUpdateState(statePath) : {};
  const last = Date.parse(state.lastCheckedAt || '') || 0;
  const cached = state.lastResult;
  if (!force && cached && cached.current === String(options.currentVersion) && now - last < intervalMs) {
    return { ...cached, cached: true, skippedVersion: state.skippedVersion || null };
  }
  const result = await checkForAppUpdate(options);
  if (statePath) {
    try { await writeUpdateState(statePath, { ...state, lastCheckedAt: new Date(now).toISOString(), lastResult: result }); } catch {}
  }
  return { ...result, cached: false, skippedVersion: state.skippedVersion || null };
}

export function describeAvailableUpdate(result) {
  if (!result || !result.available || !result.latest) return '';
  return 'OASIS ' + result.latest.version + ' is available (you have ' + result.current + ').';
}

// One line for the interactive CLI, or ''. A cached result answers instantly; a
// stale cache refreshes in the background so startup never waits on the network
// for more than `waitMs`. The refreshed answer is shown at the next start.
export async function cliUpdateNotice({ statePath, currentVersion, env = process.env, fetchImpl = fetch, waitMs = 800, now = Date.now() } = {}) {
  if (updateChecksDisabled(env) || !parseVersion(currentVersion)) return '';
  const check = cachedUpdateCheck({ statePath, currentVersion, kind: 'cli', fetchImpl, now, timeoutMs: 5000 }).catch(() => null);
  let timer;
  const result = await Promise.race([check, new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]);
  clearTimeout(timer);
  const state = await readUpdateState(statePath);
  if (!result || !shouldNotify(result, state)) return '';
  return describeAvailableUpdate(result) + ' Run oasis update to install it, or set OASIS_NO_UPDATE_CHECK=1 to stop these checks.';
}
