// Desktop update flow: check GitHub releases in the background, announce a new
// stable version with a native notification, and install it only when the user
// says so. The checks, asset choice and checksum rules live in src/app-update.mjs;
// this file only connects them to Electron. Every Electron API is injected so the
// flow can be tested without a display.
import { spawn as nodeSpawn } from 'node:child_process';
import { chmod, copyFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  RELEASES_PAGE, UPDATE_CHECK_INTERVAL_MS, cachedUpdateCheck, detectInstallKind, downloadVerifiedAsset,
  installPlan, readUpdateState, shouldNotify, updateChecksDisabled, writeUpdateState
} from '../src/app-update.mjs';

const FIRST_CHECK_DELAY_MS = 15 * 1000;

export const UPDATE_RETRY_DELAYS_MS = [2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];

export function createDesktopUpdater({
  app, dialog, shell, Notification, getWindow = () => null,
  currentVersion, statePath, downloadDirectory,
  platform = process.platform, arch = process.arch, env = process.env,
  fetchImpl = fetch, spawn = nodeSpawn, channel = 'stable', settings = {},
  setTimer = setTimeout, setRepeat = setInterval, log = () => {}
} = {}) {
  const kind = detectInstallKind({ platform, env, packaged: Boolean(app && app.isPackaged) });
  let latest = null;
  let phase = 'idle'; // idle | checking | available | downloading | ready | installing | error | current
  let progress = null;
  let lastError = '';
  let notifiedVersion = null;
  const listeners = new Set();
  const timers = [];
  let failures = 0;
  let retryTimer = null;
  let retryPending = false;

  const snapshot = () => ({
    phase, kind, current: currentVersion, channel,
    latest: latest && latest.latest ? latest.latest : null,
    available: Boolean(latest && latest.available),
    canInstall: Boolean(latest && latest.canInstall),
    asset: latest && latest.asset ? latest.asset : null,
    skippedVersion: latest ? latest.skippedVersion || null : null,
    progress, error: lastError || null,
    checkedAt: latest ? latest.checkedAt : null,
    releasesPage: latest && latest.latest ? latest.latest.url : RELEASES_PAGE
  });
  const emit = () => { const value = snapshot(); for (const listener of listeners) { try { listener(value); } catch {} } };
  const setPhase = (next) => { phase = next; emit(); };

  async function check({ manual = false } = {}) {
    if (!manual && updateChecksDisabled(env, settings)) return snapshot();
    if (phase === 'downloading' || phase === 'installing') return snapshot();
    setPhase('checking');
    try {
      latest = await cachedUpdateCheck({ statePath, force: manual, currentVersion, channel, kind, arch, fetchImpl });
      lastError = '';
      failures = 0;
      setPhase(latest.available ? 'available' : 'current');
      const state = await readUpdateState(statePath);
      if (latest.available && (manual || (shouldNotify(latest, state) && notifiedVersion !== latest.latest.version))) {
        notifiedVersion = latest.latest.version;
        await announce({ manual });
      } else if (manual && !latest.available) {
        await dialog.showMessageBox(getWindow() || undefined, {
          type: 'info', buttons: ['OK'], title: 'OASIS is up to date',
          message: 'You have the latest stable version.',
          detail: 'OASIS ' + currentVersion + ' is the newest release.'
        });
      }
    } catch (error) {
      lastError = String(error && error.message || error);
      log('update check failed: ' + lastError);
      setPhase('error');
      // A launch while offline (or a brief GitHub outage) should not wait the full
      // interval: retry background checks after 2, 10 and 30 minutes.
      if (!manual && failures < UPDATE_RETRY_DELAYS_MS.length && !retryPending) {
        const delay = UPDATE_RETRY_DELAYS_MS[failures++];
        retryPending = true;
        retryTimer = setTimer(() => { retryTimer = null; retryPending = false; void check(); }, delay);
        if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
        log('retrying the update check in ' + Math.round(delay / 60000) + ' min');
      }
      if (manual) {
        await dialog.showMessageBox(getWindow() || undefined, {
          type: 'warning', buttons: ['OK'], title: 'Could not check for updates',
          message: 'OASIS could not reach GitHub to check for a new version.', detail: lastError
        });
      }
    }
    return snapshot();
  }

  function announce({ manual = false } = {}) {
    if (!latest || !latest.available) return;
    const version = latest.latest.version;
    const show = () => { void prompt(); };
    if (!manual && Notification && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
      const note = new Notification({
        title: 'OASIS ' + version + ' is available',
        body: latest.canInstall ? 'Click to review and install the update.' : 'Click to see what changed and download it.',
        silent: false
      });
      note.on('click', show);
      note.show();
      return;
    }
    // A manual check owns a dialog interaction. Await the user's choice so the
    // caller and tests observe the completed decision, not a half-finished prompt.
    if (manual) return prompt();
    show();
  }

  async function prompt() {
    if (!latest || !latest.available) return snapshot();
    const version = latest.latest.version;
    const buttons = latest.canInstall ? ['Install and restart', 'Later', 'Skip this version', 'Release notes'] : ['Download', 'Later', 'Skip this version'];
    const notes = String(latest.latest.notes || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8).join('\n');
    const result = await dialog.showMessageBox(getWindow() || undefined, {
      type: 'info', buttons, defaultId: 0, cancelId: 1,
      title: 'Update OASIS',
      message: 'OASIS ' + version + ' is available. You have ' + currentVersion + '.',
      detail: (notes ? notes + '\n\n' : '') + (latest.canInstall
        ? 'The installer is checked against the release SHA-256 checksums before it runs. Your projects, settings and keys are kept.'
        : 'No automatic installer is published for this computer, so the release page will open.')
    });
    const choice = buttons[result.response];
    if (choice === 'Install and restart') return await install();
    if (choice === 'Download') { await shell.openExternal(latest.latest.url || RELEASES_PAGE); return snapshot(); }
    if (choice === 'Release notes') { await shell.openExternal(latest.latest.url || RELEASES_PAGE); return snapshot(); }
    if (choice === 'Skip this version') return await skip(version);
    return snapshot();
  }

  async function skip(version = latest && latest.latest && latest.latest.version) {
    if (!version) return snapshot();
    const state = await readUpdateState(statePath);
    await writeUpdateState(statePath, { ...state, skippedVersion: String(version) });
    if (latest) latest = { ...latest, skippedVersion: String(version) };
    emit();
    return snapshot();
  }

  async function install() {
    if (!latest || !latest.canInstall) {
      await shell.openExternal(latest && latest.latest ? latest.latest.url : RELEASES_PAGE);
      return snapshot();
    }
    try {
      progress = { received: 0, total: latest.asset.size || 0 };
      setPhase('downloading');
      const window = getWindow();
      const downloaded = await downloadVerifiedAsset(latest, {
        directory: downloadDirectory,
        fetchImpl,
        onProgress: (value) => {
          progress = value;
          if (window && !window.isDestroyed() && value.total) window.setProgressBar(Math.min(1, value.received / value.total));
          emit();
        }
      });
      if (window && !window.isDestroyed()) window.setProgressBar(-1);
      setPhase('ready');
      const plan = installPlan(kind, downloaded.filePath, { env });
      setPhase('installing');
      await applyPlan(plan);
    } catch (error) {
      lastError = String(error && error.message || error);
      const window = getWindow();
      if (window && !window.isDestroyed()) window.setProgressBar(-1);
      setPhase('error');
      await dialog.showMessageBox(getWindow() || undefined, {
        type: 'error', buttons: ['OK'], title: 'Update failed',
        message: 'OASIS could not install the update. Your current version still works.', detail: lastError
      });
    }
    return snapshot();
  }

  async function applyPlan(plan) {
    if (plan.action === 'spawn-and-quit') {
      const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
      if (child && typeof child.unref === 'function') child.unref();
      app.quit();
      return;
    }
    if (plan.action === 'replace-and-relaunch') {
      // Copy next to the running AppImage and rename over it: the running file
      // stays mapped until exit, and a failed copy never leaves a broken app.
      const staged = plan.target + '.update';
      await copyFile(plan.source, staged);
      await chmod(staged, 0o755);
      await rename(staged, plan.target);
      await rm(plan.source, { force: true }).catch(() => {});
      app.relaunch({ execPath: plan.target });
      app.quit();
      return;
    }
    if (plan.action === 'open') {
      const failure = await shell.openPath(plan.target);
      await dialog.showMessageBox(getWindow() || undefined, {
        type: 'info', buttons: ['OK'], title: 'Finish the update',
        message: plan.message,
        detail: failure ? 'The file is saved at ' + plan.target + '.' + (plan.command ? ' You can also run: ' + plan.command : '') : (plan.command ? 'If nothing opened, run: ' + plan.command : 'The file is saved at ' + plan.target + '.')
      });
      if (!failure) shell.showItemInFolder(plan.target);
      return;
    }
    await shell.openExternal(RELEASES_PAGE);
  }

  function start() {
    if (updateChecksDisabled(env, settings)) { log('update checks disabled'); return; }
    timers.push(setTimer(() => { void check(); }, FIRST_CHECK_DELAY_MS));
    const repeat = setRepeat(() => { void check(); }, UPDATE_CHECK_INTERVAL_MS);
    if (repeat && typeof repeat.unref === 'function') repeat.unref();
    timers.push(repeat);
  }

  function stop() {
    for (const timer of timers.splice(0)) { clearTimeout(timer); clearInterval(timer); }
    if (retryPending) { clearTimeout(retryTimer); retryTimer = null; retryPending = false; }
  }

  return {
    kind, start, stop, check, prompt, install, skip, status: snapshot,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

export function defaultUpdateDirectory(app) {
  return path.join(app.getPath('userData'), 'updates');
}
