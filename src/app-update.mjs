// App update checks for the desktop app, the browser workspace and the CLI.
//
// Every surface asks the same question ("is a newer stable release published?")
// through this module, so the answer, the asset chosen for this computer and the
// checksum rules are identical everywhere. Nothing here installs silently: the
// desktop host decides when to apply an update, and only after the downloaded
// file matches the SHA256SUMS published with the release.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchLatestRelease, githubApiHeaders } from './github-release.mjs';
// Only the functions used: the semver index loads all 47 of its modules.
import semverParse from 'semver/functions/parse.js';
import semverCompare from 'semver/functions/compare.js';
import { replaceFileDurably } from './atomic-write.mjs';
const semver = { parse: semverParse, compare: semverCompare };

const UPDATE_REPOSITORY = 'FAHTHIZ/oasis';
export const RELEASES_PAGE = 'https://github.com/' + UPDATE_REPOSITORY + '/releases/latest';
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_SUMS_BYTES = 256 * 1024;

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

// How this copy of OASIS was installed decides which release file can replace it.
//   nsis      Windows installer (.exe), can be re-run silently
//   appimage  Linux AppImage, replaced in place
//   deb       Debian/Ubuntu package, opened with the system installer
//   dmg       macOS disk image, opened for the user to drag into Applications
//   cli       npm/git install, updated with `oasis update`
export function detectInstallKind({ platform = process.platform, env = process.env, packaged = false } = {}) {
  if (!packaged) return 'cli';
  if (platform === 'win32') return 'nsis';
  if (platform === 'darwin') return 'dmg';
  if (platform === 'linux') return env.APPIMAGE ? 'appimage' : 'deb';
  return 'cli';
}

const ARCH_ALIASES = {
  x64: ['x64', 'amd64', 'x86_64'],
  arm64: ['arm64', 'aarch64'],
  ia32: ['ia32', 'x86', 'i386'],
  arm: ['armv7l', 'armhf', 'arm']
};

// Choose the release file for this computer, or null when none was published for
// it (for example an Intel Mac when only Apple Silicon images exist).
export function pickReleaseAsset(assets, { kind, arch = process.arch } = {}) {
  const list = Array.isArray(assets) ? assets.filter((asset) => asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string') : [];
  const extension = { nsis: '.exe', appimage: '.AppImage', deb: '.deb', dmg: '.dmg' }[kind];
  if (!extension) return null;
  const aliases = ARCH_ALIASES[arch] || [arch];
  const candidates = list.filter((asset) => asset.name.endsWith(extension) && !asset.name.endsWith('.blockmap'));
  const archOf = (name) => {
    const lower = name.toLowerCase();
    for (const [canonical, names] of Object.entries(ARCH_ALIASES)) {
      if (names.some((alias) => new RegExp('[-_.]' + alias + '[-_.]').test(lower))) return canonical;
    }
    return null;
  };
  const exact = candidates.find((asset) => aliases.includes(archOf(asset.name) || '') || archOf(asset.name) === arch);
  if (exact) return exact;
  // A file without an architecture in its name is treated as universal.
  return candidates.find((asset) => archOf(asset.name) === null) || null;
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
  arch = process.arch,
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
  const asset = pickReleaseAsset(release.assets, { kind, arch });
  const sums = Array.isArray(release.assets) ? release.assets.find((item) => item && item.name === 'SHA256SUMS') : null;
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
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 } : null,
    checksumsUrl: sums ? sums.browser_download_url : null,
    kind,
    canInstall: Boolean(available && asset && sums && kind !== 'cli'),
    checkedAt
  };
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

// Download the release file next to its final name, check it against the
// published SHA256SUMS, then move it into place. A mismatch deletes the file.
export async function downloadVerifiedAsset(update, { directory, fetchImpl = fetch, onProgress } = {}) {
  if (!update || !update.asset || !update.checksumsUrl) throw new Error('This release has no installer and checksum list for this computer.');
  if (!directory) throw new Error('A download folder is required.');
  const { name, url } = update.asset;
  if (!/^[\w.+-]+$/.test(name)) throw new Error('Refusing an unexpected release file name: ' + name);
  for (const value of [url, update.checksumsUrl]) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !/(^|\.)github(usercontent)?\.com$/.test(parsed.hostname)) throw new Error('Refusing to download an update from ' + parsed.hostname + '.');
  }
  const sumsResponse = await fetchImpl(update.checksumsUrl, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!sumsResponse.ok) throw new Error('Could not download SHA256SUMS (HTTP ' + sumsResponse.status + ').');
  const sumsText = await sumsResponse.text();
  if (sumsText.length > MAX_SUMS_BYTES) throw new Error('SHA256SUMS is unexpectedly large.');
  const expected = parseChecksums(sumsText).get(name);
  if (!expected) throw new Error('SHA256SUMS does not list ' + name + '.');

  await mkdir(directory, { recursive: true });
  const finalPath = path.join(directory, name);
  const partialPath = finalPath + '.partial';
  // Reuse an already verified download from an earlier attempt.
  try {
    if ((await stat(finalPath)).isFile() && await sha256File(finalPath) === expected) return { filePath: finalPath, sha256: expected, reused: true };
  } catch {}
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error('Could not download ' + name + ' (HTTP ' + response.status + ').');
  const total = Number(response.headers && response.headers.get && response.headers.get('content-length')) || update.asset.size || 0;
  if (total > MAX_ASSET_BYTES) throw new Error('The update file is unexpectedly large.');
  let received = 0;
  const hash = createHash('sha256');
  const source = Readable.fromWeb ? Readable.fromWeb(response.body) : response.body;
  source.on('data', (chunk) => {
    received += chunk.length;
    hash.update(chunk);
    if (received > MAX_ASSET_BYTES) source.destroy(new Error('The update file is unexpectedly large.'));
    if (typeof onProgress === 'function') { try { onProgress({ received, total }); } catch {} }
  });
  try {
    await pipeline(source, createWriteStream(partialPath, { mode: 0o644 }));
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
  const actual = hash.digest('hex');
  if (actual !== expected) {
    await rm(partialPath, { force: true });
    throw new Error('The downloaded update did not match its published checksum, so it was deleted. Try again later.');
  }
  await rename(partialPath, finalPath);
  return { filePath: finalPath, sha256: actual, reused: false };
}

// What the desktop host should do with a verified file. Pure so it can be tested
// on any OS; the Electron side only executes the returned plan.
export function installPlan(kind, filePath, { env = process.env } = {}) {
  if (typeof filePath !== 'string' || (!filePath && kind !== 'cli')) throw new TypeError('installPlan needs the downloaded file path (downloadVerifiedAsset(...).filePath).');
  if (kind === 'nsis') {
    // electron-builder one-click installers accept /S (silent) and relaunch with --force-run.
    return { action: 'spawn-and-quit', command: filePath, args: ['/S', '--updated', '--force-run'], message: 'OASIS will close, update and reopen.' };
  }
  if (kind === 'appimage' && env.APPIMAGE) {
    return { action: 'replace-and-relaunch', source: filePath, target: env.APPIMAGE, message: 'OASIS will restart on the new version.' };
  }
  if (kind === 'dmg') {
    return { action: 'open', target: filePath, message: 'Drag OASIS into Applications to replace the old version, then reopen it.' };
  }
  if (kind === 'deb') {
    return { action: 'open', target: filePath, message: 'Your system installer will open the package. Approve it, then reopen OASIS.', command: 'sudo apt install ' + JSON.stringify(filePath) };
  }
  return { action: 'manual', message: 'Run oasis update in a terminal.' };
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
  await replaceFileDurably(filePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
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

function describeAvailableUpdate(result) {
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
