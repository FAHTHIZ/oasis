import { app, BrowserWindow, clipboard, dialog, Menu, safeStorage, shell } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startOasisWebServer } from '../src/web.mjs';
import { loadConfig, saveConfig } from '../src/config.mjs';
import { loadDesktopApiKey, saveDesktopApiKey } from './secure-secrets.mjs';
import { crashRecoveryHtml } from './crash-screen.mjs';
import { showErrorWithCopy } from './error-dialog.mjs';

let mainWindow = null;
let runtime = null;
let activeOrigin = null;
let shuttingDown = false;
let startupComplete = false;
let recoveryScreenActive = false;
let recoveryReloadPending = false;
const desktopEnv = { ...process.env };
const inheritedOasisApiKey = process.env.OASIS_API_KEY || '';

const secureStorage = {
  isEncryptionAvailable() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux' &&
          typeof safeStorage.getSelectedStorageBackend === 'function' &&
          safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  },
  encryptString(value) { return safeStorage.encryptString(value); },
  decryptString(value) { return safeStorage.decryptString(value); }
};

const statePath = () => path.join(app.getPath('userData'), 'desktop-state.json');
const secretsPath = () => path.join(app.getPath('userData'), 'secure-secrets.json');

async function persistDesktopProviderConfig({ protocol, baseURL, model, apiKey }) {
  const filePath = secretsPath();
  const previousSecret = await loadDesktopApiKey({ filePath, safeStorage: secureStorage });
  const previousEnvKey = desktopEnv.OASIS_API_KEY;
  let secretChangeCompleted = false;
  try {
    await saveDesktopApiKey(apiKey || '', { filePath, safeStorage: secureStorage });
    secretChangeCompleted = true;
    if (apiKey) desktopEnv.OASIS_API_KEY = apiKey;
    else if (inheritedOasisApiKey) desktopEnv.OASIS_API_KEY = inheritedOasisApiKey;
    else delete desktopEnv.OASIS_API_KEY;

    // Commit the non-secret provider details in the same host callback. The web
    // route does not separately write config after this returns.
    await saveConfig({ protocol, baseURL, model, apiKey: '' }, { env: desktopEnv });
  } catch (error) {
    // A failed config write must not leave a newly saved key paired with the
    // previous provider details. Restore the prior encrypted secret best-effort.
    if (secretChangeCompleted) {
      try { await saveDesktopApiKey(previousSecret || '', { filePath, safeStorage: secureStorage }); } catch {}
    }
    if (previousEnvKey !== undefined) desktopEnv.OASIS_API_KEY = previousEnvKey;
    else delete desktopEnv.OASIS_API_KEY;
    throw error;
  }
}

async function restoreProviderSecret() {
  const saved = await loadDesktopApiKey({ filePath: secretsPath(), safeStorage: secureStorage });
  if (saved) {
    desktopEnv.OASIS_API_KEY = saved;
    return;
  }

  // Migrate an older desktop/CLI config key only when it came from the config
  // file (not from the user's environment) and OS-backed encryption is available.
  const suppliedFromEnvironment = Boolean(
    process.env.OASIS_API_KEY || process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY || process.env.OASIS_LOCAL_API_KEY
  );
  if (suppliedFromEnvironment || !secureStorage.isEncryptionAvailable()) return;
  try {
    const legacy = await loadConfig({ env: desktopEnv });
    if (!legacy.apiKey) return;
    await saveDesktopApiKey(legacy.apiKey, { filePath: secretsPath(), safeStorage: secureStorage });
    desktopEnv.OASIS_API_KEY = legacy.apiKey;
    await saveConfig({ ...legacy, apiKey: '' }, { env: desktopEnv });
  } catch {
    // Keep startup resilient. The provider form explains if secure storage is unavailable.
  }
}

async function loadState() {
  try {
    const value = JSON.parse(await readFile(statePath(), 'utf8'));
    return value && typeof value.workspace === 'string' ? value : {};
  } catch { return {}; }
}

async function saveWorkspace(root) {
  await writeFile(statePath(), JSON.stringify({ workspace: root, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

async function isDirectory(value) {
  try { return (await stat(value)).isDirectory(); } catch { return false; }
}

async function chooseWorkspace(defaultPath) {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Choose a project folder for OASIS',
    message: 'OASIS works with files inside the project folder you select.',
    defaultPath: defaultPath || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return path.resolve(result.filePaths[0]);
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    title: 'OASIS', width: 1440, height: 940, minWidth: 850, minHeight: 620,
    backgroundColor: '#0B0F0C', show: false, autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  mainWindow.once('ready-to-show', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { const parsed = new URL(url); if (parsed.protocol === 'https:') void shell.openExternal(url).catch(() => {}); } catch {}
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (recoveryScreenActive && parsed.protocol === 'data:') return;
      if (parsed.origin === activeOrigin) {
        if (recoveryScreenActive) {
          recoveryScreenActive = false;
          recoveryReloadPending = true;
        }
        return;
      }
    } catch {}
    event.preventDefault();
    try { const parsed = new URL(url); if (parsed.protocol === 'https:') void shell.openExternal(url).catch(() => {}); } catch {}
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (!recoveryReloadPending) return;
    recoveryReloadPending = false;
    void injectRuntimeToken();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details = {}) => {
    if (shuttingDown || !runtime || !mainWindow || mainWindow.isDestroyed()) return;
    recoveryScreenActive = true;
    const html = crashRecoveryHtml({
      reason: details.reason || 'unknown',
      exitCode: details.exitCode,
      restartUrl: activeOrigin + '/'
    });
    void mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(async () => {
      recoveryScreenActive = false;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      await showErrorWithCopy({
        dialog, clipboard, window: mainWindow, type: 'error',
        title: 'OASIS stopped',
        message: 'The workspace window stopped unexpectedly.',
        detail: 'Close and reopen OASIS. If this keeps happening, run oasis doctor from the terminal.'
      });
    });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

async function injectRuntimeToken() {
  if (!mainWindow || mainWindow.isDestroyed() || !runtime) return;
  const token = JSON.stringify(runtime.token);
  const source = '(function(){const token=' + token + ';try{sessionStorage.setItem("oasis.web.token",token)}catch{};const field=document.getElementById("agentTokenInput");const button=document.getElementById("agentConnectBtn");if(field)field.value=token;if(button)button.click()})()';
  try { await mainWindow.webContents.executeJavaScript(source, true); } catch {}
}

async function openWorkspace(root) {
  const resolved = path.resolve(root);
  if (!(await isDirectory(resolved))) throw new Error('That folder no longer exists. Choose a folder available on this computer.');
  if (runtime) {
    const previous = runtime;
    runtime = null;
    activeOrigin = null;
    await previous.close();
  }
  runtime = await startOasisWebServer({ root: resolved, host: '127.0.0.1', port: 0, env: desktopEnv, onProviderConfig: persistDesktopProviderConfig });
  activeOrigin = 'http://127.0.0.1:' + runtime.port;
  await saveWorkspace(resolved);
  const window = createWindow();
  await window.loadURL(activeOrigin + '/');
  await injectRuntimeToken();
}

async function chooseAndOpenWorkspace() {
  const saved = await loadState();
  const selected = await chooseWorkspace(runtime ? runtime.root : saved.workspace);
  if (!selected) return false;
  try { await openWorkspace(selected); return true; }
  catch (error) {
    await showErrorWithCopy({
      dialog, clipboard, window: mainWindow || undefined, type: 'error',
      title: 'OASIS could not open that folder',
      message: 'OASIS could not start the local workspace.',
      detail: String(error && error.message || error)
    });
    return false;
  }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open project folder…', accelerator: 'CmdOrCtrl+O', click: () => { void chooseAndOpenWorkspace(); } },
      { type: 'separator' }, { role: 'quit', label: 'Quit OASIS' }
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ...(!app.isPackaged ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])
    ]},
    { label: 'Help', submenu: [
      { label: 'OASIS documentation', click: () => { void shell.openExternal('https://github.com/FAHTHIZ/oasis#readme'); } },
      { label: 'Report a problem', click: () => { void shell.openExternal('https://github.com/FAHTHIZ/oasis/issues'); } }
    ]}
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.on('before-quit', (event) => {
    if (shuttingDown || !runtime) return;
    event.preventDefault();
    shuttingDown = true;
    const active = runtime;
    runtime = null;
    void active.close().catch(() => {}).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); return; }
    if (runtime) { const window = createWindow(); void window.loadURL(activeOrigin + '/').then(injectRuntimeToken); }
    else if (startupComplete) void chooseAndOpenWorkspace();
  });
  app.whenReady().then(async () => {
    app.setName('OASIS');
    installMenu();
    await restoreProviderSecret();
    const saved = await loadState();
    if (await isDirectory(saved.workspace)) {
      try { await openWorkspace(saved.workspace); startupComplete = true; return; }
      catch (error) {
        await showErrorWithCopy({
          dialog, clipboard, type: 'warning',
          title: 'Choose another workspace',
          message: 'OASIS could not reopen the last project folder.',
          detail: String(error && error.message || error)
        });
      }
    }
    const selected = await chooseWorkspace(saved.workspace);
    if (!selected) { app.quit(); return; }
    try { await openWorkspace(selected); startupComplete = true; }
    catch (error) {
      await showErrorWithCopy({
        dialog, clipboard, type: 'error',
        title: 'OASIS could not start',
        message: 'OASIS could not start the local workspace.',
        detail: String(error && error.message || error)
      });
      app.quit();
    }
  }).catch(async (error) => {
    await showErrorWithCopy({
      dialog, clipboard, type: 'error',
      title: 'OASIS startup failed',
      message: 'OASIS could not start. Try again, then run oasis doctor if the problem continues.',
      detail: String(error && error.message || error)
    });
    app.quit();
  });
}
