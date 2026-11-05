import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cachedUpdateCheck, checkForAppUpdate, compareVersions, detectInstallKind, downloadVerifiedAsset,
  installPlan, parseChecksums, parseVersion, pickReleaseAsset, shouldNotify, updateChecksDisabled
} from '../src/app-update.mjs';

const ASSETS = [
  'latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'OASIS-1.1.0-amd64.deb', 'OASIS-1.1.0-arm64.dmg',
  'OASIS-1.1.0-arm64.dmg.blockmap', 'OASIS-1.1.0-x64.exe', 'OASIS-1.1.0-x64.exe.blockmap', 'OASIS-1.1.0-x86_64.AppImage', 'SHA256SUMS'
].map((name) => ({ name, size: 10, browser_download_url: 'https://github.com/FAHTHIZ/oasis/releases/download/v1.1.0/' + name }));

function release(tag, extra = {}) {
  return { tag_name: tag, name: 'OASIS ' + tag, body: 'Notes', html_url: 'https://github.com/FAHTHIZ/oasis/releases/tag/' + tag, published_at: '2026-11-05T00:00:00Z', assets: ASSETS, draft: false, prerelease: false, ...extra };
}

function jsonFetch(map) {
  return async (url) => {
    const value = map[url];
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => value };
  };
}

test('versions compare numerically and releases outrank their pre-releases', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.1.0', '1.1.0-rc.1'), 1);
  assert.equal(compareVersions('1.1.0-rc.2', '1.1.0-rc.10'), -1);
  assert.equal(compareVersions('1.1.0-alpha', '1.1.0-beta'), -1);
  assert.equal(parseVersion('latest'), null);
  assert.throws(() => compareVersions('nope', '1.0.0'));
});

test('install kind follows the packaged platform', () => {
  assert.equal(detectInstallKind({ packaged: false, platform: 'win32' }), 'cli');
  assert.equal(detectInstallKind({ packaged: true, platform: 'win32' }), 'nsis');
  assert.equal(detectInstallKind({ packaged: true, platform: 'darwin' }), 'dmg');
  assert.equal(detectInstallKind({ packaged: true, platform: 'linux', env: { APPIMAGE: '/opt/OASIS.AppImage' } }), 'appimage');
  assert.equal(detectInstallKind({ packaged: true, platform: 'linux', env: {} }), 'deb');
});

test('the asset picker matches each installer and architecture, ignoring blockmaps', () => {
  assert.equal(pickReleaseAsset(ASSETS, { kind: 'nsis', arch: 'x64' }).name, 'OASIS-1.1.0-x64.exe');
  assert.equal(pickReleaseAsset(ASSETS, { kind: 'dmg', arch: 'arm64' }).name, 'OASIS-1.1.0-arm64.dmg');
  assert.equal(pickReleaseAsset(ASSETS, { kind: 'dmg', arch: 'x64' }), null, 'an Intel Mac must not get an Apple Silicon image');
  assert.equal(pickReleaseAsset(ASSETS, { kind: 'appimage', arch: 'x64' }).name, 'OASIS-1.1.0-x86_64.AppImage');
  assert.equal(pickReleaseAsset(ASSETS, { kind: 'deb', arch: 'x64' }).name, 'OASIS-1.1.0-amd64.deb');
  assert.equal(pickReleaseAsset(ASSETS, { kind: 'deb', arch: 'arm64' }), null);
  assert.equal(pickReleaseAsset(ASSETS, { kind: 'cli' }), null);
  assert.equal(pickReleaseAsset([{ name: 'OASIS-2.0.0.dmg', browser_download_url: 'https://github.com/x' }], { kind: 'dmg', arch: 'x64' }).name, 'OASIS-2.0.0.dmg', 'unlabelled files are universal');
});

test('stable checks report a newer release with the right installer', async () => {
  const fetchImpl = jsonFetch({ 'https://api.github.com/repos/FAHTHIZ/oasis/releases/latest': release('v1.1.0') });
  const result = await checkForAppUpdate({ currentVersion: '1.0.0', kind: 'nsis', arch: 'x64', fetchImpl });
  assert.equal(result.available, true);
  assert.equal(result.latest.version, '1.1.0');
  assert.equal(result.asset.name, 'OASIS-1.1.0-x64.exe');
  assert.match(result.checksumsUrl, /SHA256SUMS$/);
  assert.equal(result.canInstall, true);
  const same = await checkForAppUpdate({ currentVersion: '1.1.0', kind: 'nsis', arch: 'x64', fetchImpl });
  assert.equal(same.available, false);
  const cli = await checkForAppUpdate({ currentVersion: '1.0.0', kind: 'cli', fetchImpl });
  assert.equal(cli.available, true);
  assert.equal(cli.canInstall, false, 'CLI installs update through oasis update, not an installer');
});

test('stable checks ignore pre-releases, while the beta channel accepts them', async () => {
  const fetchImpl = jsonFetch({
    'https://api.github.com/repos/FAHTHIZ/oasis/releases/latest': release('v1.2.0-rc.1', { prerelease: true }),
    'https://api.github.com/repos/FAHTHIZ/oasis/releases?per_page=20': [release('v1.1.0'), release('v1.2.0-rc.1', { prerelease: true }), release('garbage'), release('v9.0.0', { draft: true })]
  });
  assert.equal((await checkForAppUpdate({ currentVersion: '1.1.0', fetchImpl })).available, false);
  const beta = await checkForAppUpdate({ currentVersion: '1.1.0', channel: 'beta', fetchImpl });
  assert.equal(beta.available, true);
  assert.equal(beta.latest.version, '1.2.0-rc.1');
});

test('no published release is "no update", and HTTP errors are reported', async () => {
  const none = await checkForAppUpdate({ currentVersion: '1.0.0', fetchImpl: jsonFetch({}) });
  assert.equal(none.available, false);
  await assert.rejects(checkForAppUpdate({ currentVersion: '1.0.0', fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(checkForAppUpdate({ currentVersion: 'dev', fetchImpl: jsonFetch({}) }), /not a valid version/);
});

test('checksum lists parse sha256sum output, with or without ./ and binary markers', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseChecksums(a + '  ./OASIS-1.1.0-x64.exe\n' + b + ' *OASIS-1.1.0-arm64.dmg\nnot a line\n');
  assert.equal(sums.get('OASIS-1.1.0-x64.exe'), a);
  assert.equal(sums.get('OASIS-1.1.0-arm64.dmg'), b.toLowerCase());
  assert.equal(sums.size, 2);
});

function bodyFetch(files) {
  return async (url) => {
    const name = url.split('/').pop();
    if (!(name in files)) return { ok: false, status: 404 };
    const bytes = Buffer.from(files[name]);
    return {
      ok: true, status: 200,
      headers: { get: (key) => key === 'content-length' ? String(bytes.length) : null },
      text: async () => bytes.toString('utf8'),
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } })
    };
  };
}

test('downloads are verified against SHA256SUMS before they are kept', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-update-'));
  try {
    const payload = 'installer bytes';
    const digest = createHash('sha256').update(payload).digest('hex');
    const update = {
      asset: { name: 'OASIS-1.1.0-x64.exe', url: 'https://github.com/FAHTHIZ/oasis/releases/download/v1.1.0/OASIS-1.1.0-x64.exe', size: payload.length },
      checksumsUrl: 'https://github.com/FAHTHIZ/oasis/releases/download/v1.1.0/SHA256SUMS'
    };
    const progress = [];
    const ok = await downloadVerifiedAsset(update, { directory: dir, fetchImpl: bodyFetch({ 'OASIS-1.1.0-x64.exe': payload, SHA256SUMS: digest + '  OASIS-1.1.0-x64.exe\n' }), onProgress: (p) => progress.push(p) });
    assert.equal(await readFile(ok.filePath, 'utf8'), payload);
    assert.equal(ok.sha256, digest);
    assert.ok(progress.length >= 1);
    const again = await downloadVerifiedAsset(update, { directory: dir, fetchImpl: bodyFetch({ SHA256SUMS: digest + '  OASIS-1.1.0-x64.exe\n' }) });
    assert.equal(again.reused, true, 'an already verified file is reused without downloading');

    await rm(ok.filePath);
    await assert.rejects(
      downloadVerifiedAsset(update, { directory: dir, fetchImpl: bodyFetch({ 'OASIS-1.1.0-x64.exe': 'tampered', SHA256SUMS: digest + '  OASIS-1.1.0-x64.exe\n' }) }),
      /did not match its published checksum/
    );
    await assert.rejects(readFile(ok.filePath), 'a mismatched download is deleted');
    await assert.rejects(downloadVerifiedAsset(update, { directory: dir, fetchImpl: bodyFetch({ SHA256SUMS: 'f'.repeat(64) + '  other.exe\n' }) }), /does not list/);
    await assert.rejects(downloadVerifiedAsset({ ...update, asset: { ...update.asset, url: 'https://evil.example/OASIS.exe' } }, { directory: dir, fetchImpl: bodyFetch({}) }), /Refusing to download/);
    await assert.rejects(downloadVerifiedAsset({ ...update, asset: { ...update.asset, name: '../escape.exe' } }, { directory: dir, fetchImpl: bodyFetch({}) }), /unexpected release file name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install plans per installer type', () => {
  assert.deepEqual(installPlan('nsis', 'C:\\t\\OASIS.exe').args, ['/S', '--updated', '--force-run']);
  assert.equal(installPlan('appimage', '/tmp/new.AppImage', { env: { APPIMAGE: '/home/u/OASIS.AppImage' } }).target, '/home/u/OASIS.AppImage');
  assert.equal(installPlan('appimage', '/tmp/new.AppImage', { env: {} }).action, 'manual');
  assert.equal(installPlan('dmg', '/tmp/OASIS.dmg').action, 'open');
  assert.match(installPlan('deb', '/tmp/OASIS.deb').command, /apt install/);
  assert.equal(installPlan('cli', '').action, 'manual');
});

test('update checks can be disabled and skipped versions stay quiet', () => {
  assert.equal(updateChecksDisabled({ OASIS_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(updateChecksDisabled({ CI: 'true' }), true);
  assert.equal(updateChecksDisabled({ CI: 'true', OASIS_UPDATE_CHECK: '1' }), false);
  assert.equal(updateChecksDisabled({}, { updateCheck: false }), true);
  assert.equal(updateChecksDisabled({}), false);
  const result = { available: true, latest: { version: '1.1.0' } };
  assert.equal(shouldNotify(result, {}), true);
  assert.equal(shouldNotify(result, { skippedVersion: '1.1.0' }), false);
  assert.equal(shouldNotify({ ...result, latest: { version: '1.2.0' } }, { skippedVersion: '1.1.0' }), true);
  assert.equal(shouldNotify({ available: false }, {}), false);
});

test('cached checks reuse a fresh result and refresh a stale one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-update-state-'));
  try {
    const statePath = path.join(dir, 'state.json');
    let calls = 0;
    const fetchImpl = async (url) => { calls += 1; return jsonFetch({ [url]: release('v1.1.0') })(url); };
    const now = Date.parse('2026-11-05T00:00:00Z');
    const first = await cachedUpdateCheck({ statePath, now, currentVersion: '1.0.0', fetchImpl });
    assert.equal(first.cached, false);
    const second = await cachedUpdateCheck({ statePath, now: now + 1000, currentVersion: '1.0.0', fetchImpl });
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    await cachedUpdateCheck({ statePath, now: now + 7 * 3600 * 1000, currentVersion: '1.0.0', fetchImpl });
    assert.equal(calls, 2, 'a check older than six hours is refreshed');
    await cachedUpdateCheck({ statePath, now: now + 7 * 3600 * 1000 + 5, currentVersion: '1.1.0', fetchImpl });
    assert.equal(calls, 3, 'a different installed version invalidates the cache');
    await writeFile(statePath, '{broken');
    assert.equal((await cachedUpdateCheck({ statePath, now, currentVersion: '1.0.0', fetchImpl })).available, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI notice is instant from cache, bounded on a cold start, and respects opt-out', async () => {
  const { cliUpdateNotice } = await import('../src/app-update.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-update-cli-'));
  try {
    const statePath = path.join(dir, 'state.json');
    const fetchImpl = jsonFetch({ 'https://api.github.com/repos/FAHTHIZ/oasis/releases/latest': release('v1.1.0') });
    const notice = await cliUpdateNotice({ statePath, currentVersion: '1.0.0', env: {}, fetchImpl });
    assert.match(notice, /OASIS 1\.1\.0 is available \(you have 1\.0\.0\)\. Run oasis update/);
    assert.equal(await cliUpdateNotice({ statePath, currentVersion: '1.1.0', env: {}, fetchImpl }), '');
    assert.equal(await cliUpdateNotice({ statePath, currentVersion: '1.0.0', env: { OASIS_NO_UPDATE_CHECK: '1' }, fetchImpl }), '');
    const slow = () => new Promise(() => {});
    const started = Date.now();
    assert.equal(await cliUpdateNotice({ statePath: path.join(dir, 'cold.json'), currentVersion: '1.0.0', env: {}, fetchImpl: slow, waitMs: 50 }), '');
    assert.ok(Date.now() - started < 1000, 'a hung network never delays startup');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
