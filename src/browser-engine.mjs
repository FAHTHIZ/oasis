// Browser engines for the built-in browser tool.
//
// OASIS drives two engines through one Chrome DevTools Protocol client (cdp.mjs):
//
//   obscura  A headless engine written in Rust (V8, its own DOM, layout and paint;
//            https://github.com/h4ckf0r0day/obscura, Apache-2.0). It starts in well
//            under a second and uses a fraction of Chrome's memory, so every agent
//            and subagent can have its own browser. It is the default.
//   chrome   Chrome, Chromium, Edge or Brave. Used when a visible window is wanted,
//            when attaching to your own signed-in browser (OASIS_CHROME_PORT), and as
//            the automatic fallback for pages Obscura cannot load or render.
//
// OASIS_BROWSER_ENGINE=auto|obscura|chrome picks one (auto is the default).
// OASIS_OBSCURA_PATH points at an Obscura binary; otherwise OASIS looks on PATH
// and in its own cache, and `oasis browser install` (or the first browser call,
// after asking) downloads the pinned release below and checks its SHA-256.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { promisify } from 'node:util';
import { findChrome } from './cdp.mjs';

const execFileAsync = promisify(execFile);

export const ENGINES = ['obscura', 'chrome'];

// The release OASIS installs. Checksums are pinned here rather than read from the
// network, so a replaced release asset cannot be installed silently.
export const OBSCURA_RELEASE = {
  version: '0.2.7',
  tag: 'v0.2.7',
  base: 'https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.7/',
  assets: {
    'linux-x64': { file: 'obscura-x86_64-linux.tar.gz', sha256: '11b53d27cd743e00e196e216920e7f3f794cf378e3f1792b8d25d3beabaf9cad' },
    'linux-arm64': { file: 'obscura-aarch64-linux.tar.gz', sha256: '4ee0aeeb38fa8bb2cb004ba104abe1c79f1bdfd02f51672c694e8234a5ae0e5c' },
    'darwin-x64': { file: 'obscura-x86_64-macos.tar.gz', sha256: 'c47383e5b5551e09d2055ee7bdcce788af409fb4394e39bdaf179734df18e829' },
    'darwin-arm64': { file: 'obscura-aarch64-macos.tar.gz', sha256: 'fc7e73f23058f18d6d5be983d83b24ba374d12167677657a307a9476c0f5a7c1' },
    'win32-x64': { file: 'obscura-x86_64-windows.zip', sha256: 'be983b663552e11faf8c1e07696578bad622dbeb48afb9f59036032ca8e97fb3' }
  }
};

// Large enough for the release archives (about 75 MB), small enough that a
// misbehaving mirror cannot fill the disk.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function obscuraAsset(platform = process.platform, arch = process.arch) {
  return OBSCURA_RELEASE.assets[platform + '-' + arch] || null;
}

function exeName(platform = process.platform) {
  return platform === 'win32' ? 'obscura.exe' : 'obscura';
}

export function obscuraCacheRoot(env = process.env, platform = process.platform) {
  if (env.OASIS_OBSCURA_CACHE) return env.OASIS_OBSCURA_CACHE;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'oasis', 'obscura');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'oasis', 'obscura');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'oasis', 'obscura');
}

export function obscuraInstallDir(env = process.env, platform = process.platform) {
  return path.join(obscuraCacheRoot(env, platform), OBSCURA_RELEASE.version);
}

function isFile(file) {
  try { return existsSync(file); } catch { return false; }
}

/** The Obscura binary to use, or null. An explicit path that does not exist is null, not a fallback. */
export function findObscura(env = process.env, platform = process.platform) {
  const explicit = env.OASIS_OBSCURA_PATH;
  if (explicit) return isFile(explicit) ? explicit : null;
  const installed = path.join(obscuraInstallDir(env, platform), exeName(platform));
  if (isFile(installed)) return installed;
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, exeName(platform));
    if (isFile(candidate)) return candidate;
  }
  // An older pinned version in the cache still works until the new one is installed.
  try {
    const root = obscuraCacheRoot(env, platform);
    const versions = readdirSync(root).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(compareVersions).reverse();
    for (const version of versions) {
      const candidate = path.join(root, version, exeName(platform));
      if (isFile(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** The engine preference from the environment: auto, obscura or chrome. */
export function enginePreference(env = process.env) {
  const raw = String(env.OASIS_BROWSER_ENGINE || 'auto').trim().toLowerCase();
  if (raw === 'chromium' || raw === 'edge' || raw === 'brave') return 'chrome';
  return ENGINES.includes(raw) ? raw : 'auto';
}

/**
 * Decide which engine to start for a session. `visible` means the caller wants a
 * window (a desktop session asked for one, or an agent's virtual screen), which
 * only Chrome can give. Returns { engine, executable, reason, installable }.
 */
export function resolveEngine({ env = process.env, visible = false, attachPort = 0, platform = process.platform } = {}) {
  if (attachPort) return { engine: 'chrome', executable: null, reason: 'attached to the browser on port ' + attachPort };
  const preference = enginePreference(env);
  const chrome = findChrome(env, platform);
  const obscura = findObscura(env, platform);
  const installable = Boolean(obscuraAsset(platform)) && !env.OASIS_OBSCURA_PATH;
  if (preference === 'chrome') return { engine: 'chrome', executable: chrome, reason: 'OASIS_BROWSER_ENGINE=chrome' };
  if (preference === 'obscura') return { engine: 'obscura', executable: obscura, reason: 'OASIS_BROWSER_ENGINE=obscura', installable };
  if (visible && chrome) return { engine: 'chrome', executable: chrome, reason: 'a visible browser window was requested' };
  if (obscura) return { engine: 'obscura', executable: obscura, reason: 'default engine' };
  if (chrome) return { engine: 'chrome', executable: chrome, reason: 'Obscura is not installed (oasis browser install adds it)' };
  return { engine: 'obscura', executable: null, reason: 'no browser installed', installable };
}

function sha256Transform(hash, limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) { callback(new Error('The Obscura download is larger than expected.')); return; }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
}

/**
 * Download, verify and unpack the pinned Obscura release into the cache. Safe to
 * call concurrently: each call unpacks into its own temporary folder and the final
 * rename is atomic; a second caller that loses the race uses the winner's copy.
 */
export async function installObscura({ env = process.env, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch, onProgress = null } = {}) {
  const asset = obscuraAsset(platform, arch);
  if (!asset) throw new Error('Obscura has no prebuilt release for ' + platform + '-' + arch + '. Build it from source and set OASIS_OBSCURA_PATH, or use Chrome (OASIS_BROWSER_ENGINE=chrome).');
  const finalDir = obscuraInstallDir(env, platform);
  const finalExe = path.join(finalDir, exeName(platform));
  if (isFile(finalExe)) return { path: finalExe, version: OBSCURA_RELEASE.version, installed: false };
  const root = obscuraCacheRoot(env, platform);
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(path.join(root, '.install-'));
  try {
    const archive = path.join(work, asset.file);
    const url = OBSCURA_RELEASE.base + asset.file;
    if (onProgress) onProgress('Downloading ' + url);
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error('Could not download Obscura (' + (response.status || 'no response') + ').');
    const hash = createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), sha256Transform(hash, MAX_ARCHIVE_BYTES), createWriteStream(archive));
    const digest = hash.digest('hex');
    if (digest !== asset.sha256) throw new Error('The Obscura download did not match its pinned SHA-256 (got ' + digest + '). Nothing was installed.');
    const unpacked = path.join(work, 'unpacked');
    await mkdir(unpacked);
    // bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz; bsdtar also reads .zip.
    await execFileAsync('tar', ['-xf', archive, '-C', unpacked], { timeout: 120000 });
    const exe = path.join(unpacked, exeName(platform));
    if (!isFile(exe)) throw new Error('The Obscura archive did not contain ' + exeName(platform) + '.');
    if (platform !== 'win32') {
      await chmod(exe, 0o755);
      const worker = path.join(unpacked, 'obscura-worker');
      if (isFile(worker)) await chmod(worker, 0o755);
    }
    await rm(archive, { force: true });
    try { await rename(unpacked, finalDir); }
    catch (error) { if (!isFile(finalExe)) throw error; }
    return { path: finalExe, version: OBSCURA_RELEASE.version, installed: true };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Version string reported by a binary, or '' when it does not run. */
export async function obscuraVersion(executable) {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 10000 });
    return String(stdout).trim();
  } catch { return ''; }
}

/** One status line per engine for /browser status and oasis doctor. */
export async function engineStatus(env = process.env) {
  const obscura = findObscura(env);
  const chrome = findChrome(env);
  const size = obscura ? await stat(obscura).then((s) => s.size).catch(() => 0) : 0;
  return {
    preference: enginePreference(env),
    obscura: obscura ? { path: obscura, version: await obscuraVersion(obscura), bytes: size } : null,
    chrome: chrome ? { path: chrome } : null,
    installable: Boolean(obscuraAsset()),
    pinned: OBSCURA_RELEASE.version
  };
}

/** The `oasis browser status` / `/browser status` text. */
export function formatEngineStatus(status, { enabled = null, open = false } = {}) {
  const lines = [];
  if (enabled !== null) lines.push('Browser tool: ' + (enabled ? 'on' : 'off') + (open ? ' (browser open)' : ''));
  lines.push('Engine preference: ' + status.preference + (status.preference === 'auto' ? ' (Obscura when installed, Chrome for visible windows, sites that need it, or when Obscura is missing)' : ''));
  lines.push('Obscura: ' + (status.obscura ? status.obscura.path + (status.obscura.version ? ' (' + status.obscura.version + ')' : '') : 'not installed' + (status.installable ? ' (oasis browser install fetches the pinned ' + status.pinned + ' release)' : ' (no prebuilt release for this platform)')));
  lines.push('Chrome: ' + (status.chrome ? status.chrome.path : 'not found (set OASIS_CHROME_PATH)'));
  return lines.join('\n');
}
