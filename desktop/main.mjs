import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startOasisWebServer } from '../src/web.mjs';

let mainWindow = null;
let runtime = null;
let activeOrigin = null;
let shuttingDown = false;
let startupComplete = false;

const statePath = () => path.join(app.getPath('userData'), 'desktop-state.json');

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
    try { if (new URL(url).origin === activeOrigin) return; } catch {}
    event.preventDefault();
    try { const parsed = new URL(url); if (parsed.protocol === 'https:') void shell.openExternal(url).catch(() => {}); } catch {}
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
  runtime = await startOasisWebServer({ root: resolved, host: '127.0.0.1', port: 0 });
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
    await dialog.showMessageBox(mainWindow || undefined, {
      type: 'error', title: 'OASIS could not open that folder',
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
    const saved = await loadState();
    if (await isDirectory(saved.workspace)) {
      try { await openWorkspace(saved.workspace); startupComplete = true; return; }
      catch (error) {
        await dialog.showMessageBox({ type: 'warning', title: 'Choose another workspace', message: 'OASIS could not reopen the last project folder.', detail: String(error && error.message || error) });
      }
    }
    const selected = await chooseWorkspace(saved.workspace);
    if (!selected) { app.quit(); return; }
    try { await openWorkspace(selected); startupComplete = true; }
    catch (error) {
      await dialog.showMessageBox({ type: 'error', title: 'OASIS could not start', message: 'OASIS could not start the local workspace.', detail: String(error && error.message || error) });
      app.quit();
    }
  }).catch(async (error) => {
    await dialog.showMessageBox({ type: 'error', title: 'OASIS startup failed', message: String(error && error.message || error) });
    app.quit();
  });
}
