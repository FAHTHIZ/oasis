import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopUpdater } from '../desktop/updater.mjs';

const BASE = 'https://github.com/FAHTHIZ/oasis/releases/download/v1.1.0/';

function fakeElectron({ responses = [] } = {}) {
  const calls = [];
  const notifications = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; this.handlers = {}; notifications.push(this); }
    on(name, fn) { this.handlers[name] = fn; }
    show() { calls.push('notify:' + this.options.title); }
  }
  const dialog = {
    async showMessageBox(_window, options) {
      calls.push('dialog:' + options.title);
      const next = responses.shift();
      const index = next === undefined ? 1 : options.buttons.indexOf(next);
      return { response: index < 0 ? 1 : index };
    }
  };
  const shell = {
    async openExternal(url) { calls.push('external:' + url); },
    async openPath(target) { calls.push('open:' + path.basename(target)); return ''; },
    showItemInFolder(target) { calls.push('reveal:' + path.basename(target)); }
  };
  const app = { isPackaged: true, quit() { calls.push('quit'); }, relaunch(options) { calls.push('relaunch:' + options.execPath); } };
  return { calls, notifications, dialog, shell, app, Notification };
}

function releaseFetch({ installer = 'new build', tamper = false, latest = 'v1.1.0' } = {}) {
  const digest = createHash('sha256').update(installer).digest('hex');
  const names = ['OASIS-1.1.0-x64.exe', 'OASIS-1.1.0-x86_64.AppImage', 'OASIS-1.1.0-arm64.dmg', 'OASIS-1.1.0-amd64.deb', 'SHA256SUMS'];
  const sums = names.filter((n) => n !== 'SHA256SUMS').map((n) => digest + '  ' + n).join('\n') + '\n';
  return async (url) => {
    if (url.endsWith('/releases/latest')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: latest, name: 'OASIS ' + latest, body: 'Faster startup\nUpdate notices', html_url: 'https://github.com/FAHTHIZ/oasis/releases/tag/' + latest, assets: names.map((name) => ({ name, size: installer.length, browser_download_url: BASE + name })) }) };
    }
    const name = url.split('/').pop();
    const bytes = Buffer.from(name === 'SHA256SUMS' ? sums : (tamper ? 'evil' : installer));
    return { ok: true, status: 200, headers: { get: () => String(bytes.length) }, text: async () => bytes.toString(), body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }) };
  };
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-desktop-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const electron = fakeElectron(options);
  const spawned = [];
  const updater = createDesktopUpdater({
    ...electron,
    currentVersion: '1.0.0',
    statePath: path.join(dir, 'update-state.json'),
    downloadDirectory: path.join(dir, 'updates'),
    platform: options.platform || 'win32', arch: options.arch || 'x64', env: options.env || {},
    fetchImpl: releaseFetch(options),
    spawn: (command, args) => { spawned.push([path.basename(command), ...args]); return { unref() {} }; },
    setTimer: () => 0, setRepeat: () => ({ unref() {} })
  });
  return { dir, updater, spawned, ...electron };
}

test('a background check shows one native notification for a new stable release', async (t) => {
  const { updater, calls, notifications } = await setup(t);
  const states = [];
  updater.onChange((s) => states.push(s.phase));
  const status = await updater.check();
  assert.equal(status.available, true);
  assert.equal(status.latest.version, '1.1.0');
  assert.equal(status.canInstall, true);
  assert.deepEqual(calls, ['notify:OASIS 1.1.0 is available']);
  assert.deepEqual(states, ['checking', 'available']);
  await updater.check();
  assert.equal(notifications.length, 1, 'the same version is announced once per run');
});

test('Windows: install downloads, verifies, runs the silent installer and quits', async (t) => {
  const { updater, calls, spawned, notifications } = await setup(t, { responses: ['Install and restart'] });
  await updater.check();
  notifications[0].handlers.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(spawned, [['OASIS-1.1.0-x64.exe', '/S', '--updated', '--force-run']]);
  assert.ok(calls.includes('quit'));
  assert.equal(updater.status().phase, 'installing');
});

test('a tampered download is refused and the current version keeps running', async (t) => {
  const { updater, calls, spawned } = await setup(t, { tamper: true });
  await updater.check();
  const status = await updater.install();
  assert.equal(status.phase, 'error');
  assert.match(status.error, /checksum/);
  assert.deepEqual(spawned, []);
  assert.ok(!calls.includes('quit'));
  assert.ok(calls.includes('dialog:Update failed'));
});

test('Linux AppImage: the file is replaced in place and the app relaunches', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-appimage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appImage = path.join(dir, 'OASIS.AppImage');
  await writeFile(appImage, 'old build');
  const { updater, calls } = await setup(t, { platform: 'linux', env: { APPIMAGE: appImage } });
  await updater.check();
  await updater.install();
  assert.equal(await readFile(appImage, 'utf8'), 'new build');
  assert.ok(calls.includes('relaunch:' + appImage));
  assert.ok(calls.includes('quit'));
});

test('macOS and .deb: the verified file is opened for the system installer', async (t) => {
  const mac = await setup(t, { platform: 'darwin', arch: 'arm64' });
  await mac.updater.check();
  await mac.updater.install();
  assert.ok(mac.calls.includes('open:OASIS-1.1.0-arm64.dmg'));
  assert.ok(mac.calls.includes('dialog:Finish the update'));
  assert.ok(!mac.calls.includes('quit'));
  const deb = await setup(t, { platform: 'linux', env: {} });
  await deb.updater.check();
  await deb.updater.install();
  assert.ok(deb.calls.includes('open:OASIS-1.1.0-amd64.deb'));
});

test('an Intel Mac without a matching image is sent to the release page', async (t) => {
  const { updater, calls } = await setup(t, { platform: 'darwin', arch: 'x64' });
  const status = await updater.check();
  assert.equal(status.available, true);
  assert.equal(status.canInstall, false);
  await updater.install();
  assert.ok(calls.some((c) => c.startsWith('external:https://github.com/FAHTHIZ/oasis/releases/tag/v1.1.0')));
});

test('skip this version silences later background checks', async (t) => {
  const { updater, dir } = await setup(t, { responses: ['Skip this version'] });
  await updater.check({ manual: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updater.status().skippedVersion, '1.1.0');
  const electron = fakeElectron();
  const nextRun = createDesktopUpdater({ ...electron, currentVersion: '1.0.0', statePath: path.join(dir, 'update-state.json'), downloadDirectory: dir, fetchImpl: releaseFetch(), platform: 'win32', arch: 'x64', env: {} });
  const status = await nextRun.check();
  assert.equal(status.available, true);
  assert.deepEqual(electron.calls, [], 'a skipped version is not announced on the next launch');
  const newer = createDesktopUpdater({ ...electron, currentVersion: '1.0.0', statePath: path.join(dir, 'update-state.json'), downloadDirectory: dir, fetchImpl: releaseFetch({ latest: 'v1.2.0' }), platform: 'win32', arch: 'x64', env: {} });
  await newer.check({ manual: false });
  assert.deepEqual(electron.calls, [], 'the cached 1.1.0 result is still fresh');
});

test('manual checks report "up to date" and network failures in a dialog', async (t) => {
  const current = await setup(t, { latest: 'v1.0.0' });
  await current.updater.check({ manual: true });
  assert.ok(current.calls.includes('dialog:OASIS is up to date'));
  const { dir } = current;
  const electron = fakeElectron();
  const offline = createDesktopUpdater({ ...electron, currentVersion: '1.0.0', statePath: path.join(dir, 'offline.json'), downloadDirectory: dir, platform: 'win32', env: {}, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); } });
  const status = await offline.check({ manual: true });
  assert.equal(status.phase, 'error');
  assert.ok(electron.calls.includes('dialog:Could not check for updates'));
});

test('OASIS_NO_UPDATE_CHECK disables background checks entirely', async (t) => {
  let fetched = false;
  const electron = fakeElectron();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-noupdate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let scheduled = 0;
  const updater = createDesktopUpdater({ ...electron, currentVersion: '1.0.0', statePath: path.join(dir, 's.json'), env: { OASIS_NO_UPDATE_CHECK: '1' }, fetchImpl: async () => { fetched = true; }, setTimer: () => { scheduled += 1; }, setRepeat: () => { scheduled += 1; return {}; } });
  updater.start();
  await updater.check();
  assert.equal(scheduled, 0);
  assert.equal(fetched, false);
});
