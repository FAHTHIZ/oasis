// OASIS universal app: UI wiring. Opened on its own, all agent work happens
// in this browser. Opened from `oasis web` or the desktop app, the same UI
// drives the agent on that computer (runtime engine, core/runtime.mjs).
import { PRESETS, testProvider } from './core/providers.mjs';
import { IndexedDBStore, Workspace, lineDiff } from './core/workspace.mjs';
import { Agent, textOf } from './core/agent.mjs';
import { FrameSandbox } from './core/sandbox.mjs';
import { SkillLibrary } from './core/skills.mjs';
import { GitHub, parseRepo } from './core/github.mjs';
import { createZip, readZip } from './core/zip.mjs';
import { renderMarkdown } from './markdown.mjs';
import { smartConnect, looksLikeConnection, parsePaste, scanLocal, buildChain, nextInChain, configFor, classifyFailure, maskSecret, isGitHubToken } from './core/connect.mjs';
import { PLUGINS, getPlugin, pluginsFor, suggestPlugins } from './core/plugins.mjs';
import { detectRuntime, RuntimeAgent, RuntimeWorkspace, tokenFromPaste, saveRuntimeToken } from './core/runtime.mjs';
import { APP_KEYBOARD_SHORTCUTS, searchAppCommands } from './core/command-palette.mjs';
import { normalizeTaskProgress } from './core/task-progress.mjs';
import { RuntimeTerminal, loadXterm } from './core/terminal.mjs';
import { suggestToken, rankSuggestions, applySuggestion } from './core/composer-suggest.mjs';
// Composer autocomplete state (declared early: refreshFiles clears the file cache).
const suggest = { token: null, items: [], index: 0, commands: null, files: null, seq: 0 };

const APP_VERSION = '1.3.0';
const $ = (id) => document.getElementById(id);
const store = new IndexedDBStore();
const sandbox = new FrameSandbox();
const skills = new SkillLibrary({ baseURL: new URL('skills/', location.href).href });

const DEFAULTS = { connections: [], activeConnection: '', activeModel: '', autoSwitch: true, projectPlugins: {}, mode: 'ask', maxSteps: 40, theme: 'system', githubToken: '', notify: false };
// Slow phones and old computers: fewer repaints while a reply streams, no
// blur or animation, and a shorter transcript kept in the page.
const LITE_PARAM = new URLSearchParams(location.search).get('lite');
const LITE = LITE_PARAM === '1' ? true : LITE_PARAM === '0' ? false : Boolean((navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) || (navigator.connection && navigator.connection.saveData) || matchMedia('(prefers-reduced-motion: reduce)').matches);
document.documentElement.classList.toggle('lite', LITE);
const failedModels = {};  // connectionId|model -> time it last failed, for the fallback chain
let turnPlugins = [];      // plugins tapped for the next message only
let settings = loadSettings();
let workspace = null;
let display = [];          // rendered history: [{ role, content, tools: [{id,name,args,ok,content}] }]
let currentTurn = null;    // DOM refs for the assistant reply being streamed
let allowEditsThisSession = false;
// Runtime engine: set at boot when a local OASIS runtime serves this page.
// { client, status, needsToken, entry } or null for the in-browser engine.
let RT = null;

/* ---------- Settings ---------- */
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('oasis.settings') || '{}') || {}; } catch { saved = {}; }
  const merged = { ...DEFAULTS, ...saved };
  if (!Array.isArray(merged.connections)) merged.connections = [];
  // Settings from 1.2 and earlier held one provider; keep it as a connection.
  if (!merged.connections.length && saved.model && (saved.apiKey || /localhost|127\.0\.0\.1/.test(saved.baseURL || '') || saved.provider === 'custom')) {
    const preset = PRESETS[saved.provider] || PRESETS.custom;
    merged.connections.push({ id: 'legacy', provider: saved.provider || 'custom', label: preset.label, protocol: saved.protocol || preset.protocol, baseURL: saved.baseURL || preset.baseURL, apiKey: saved.apiKey || '', models: [saved.model], local: /localhost|127\.0\.0\.1/.test(saved.baseURL || ''), addedAt: Date.now() });
    merged.activeConnection = 'legacy';
    merged.activeModel = saved.model;
  }
  for (const key of ['provider', 'baseURL', 'model', 'apiKey', 'protocol']) delete merged[key];
  return merged;
}
function saveSettings() { localStorage.setItem('oasis.settings', JSON.stringify(settings)); }
function activeEntry() {
  if (RT) return RT.entry || null;
  const connection = settings.connections.find((c) => c.id === settings.activeConnection) || settings.connections[0];
  if (!connection) return null;
  const model = settings.activeModel && (connection.models.includes(settings.activeModel) || connection.id === settings.activeConnection) ? settings.activeModel : connection.models[0];
  return model ? { connection, model } : null;
}
// Plan mode needs OASIS on a computer; the browser-only agent treats it as Ask first.
function currentMode() {
  if (settings.mode === 'plan' && !(RT && !RT.needsToken)) return 'ask';
  return allowEditsThisSession && settings.mode === 'ask' ? 'edits' : settings.mode;
}
const MODE_CYCLE = ['ask', 'edits', 'auto', 'plan'];
function cycleMode() {
  const modes = MODE_CYCLE.filter((mode) => mode !== 'plan' || (RT && !RT.needsToken));
  settings.mode = modes[(modes.indexOf(currentMode()) + 1) % modes.length];
  allowEditsThisSession = false;
  saveSettings();
  updateModeUI();
  toast('Mode: ' + $('modeLabel').textContent);
}
function providerConfig() {
  const entry = activeEntry();
  if (!entry) return { protocol: 'openai', baseURL: '', apiKey: '', model: '', mode: currentMode(), provider: '' };
  return configFor(entry, { mode: currentMode() });
}
function modelReady() {
  if (RT) return Boolean(RT.entry);
  const entry = activeEntry();
  return Boolean(entry && entry.model && (entry.connection.apiKey || entry.connection.local || /localhost|127\.0\.0\.1/.test(entry.connection.baseURL) || entry.connection.provider === 'custom'));
}
function setActive(connectionId, model) {
  if (RT) { runtimeSwitchModel(model); return; }
  settings.activeConnection = connectionId;
  settings.activeModel = model;
  saveSettings();
  updateModeUI();
}
function upsertConnection(connection) {
  const same = settings.connections.find((c) => c.provider === connection.provider && c.baseURL === connection.baseURL && (c.apiKey || '') === (connection.apiKey || ''));
  if (same) {
    same.models = [...new Set([...connection.models, ...same.models])].slice(0, 80);
    same.label = connection.label;
    return same;
  }
  connection.models = connection.models.slice(0, 80);
  settings.connections.push(connection);
  return connection;
}
function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.classList.toggle('light', !dark);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0B100C' : '#F6F8F4';
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

/* ---------- Toasts ---------- */
function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

/* ---------- Command palette and keyboard guide ---------- */
const dialogReturnFocus = new Map();
const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
const modifierLabel = isApplePlatform ? '⌘' : 'Ctrl';
let commandPaletteSelected = 0;

function displayShortcut(keys) {
  return String(keys || '').replaceAll('MOD', modifierLabel).replace(/[+]/g, ' + ');
}

function openNativeDialog(id) {
  const dialog = $(id);
  if (!dialog || dialog.open) return;
  dialogReturnFocus.set(id, document.activeElement);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  if (id === 'commandPaletteDialog') {
    $('commandPaletteInput').value = '';
    renderCommandPalette();
    $('commandPaletteModKey').textContent = displayShortcut('MOD+K');
    requestAnimationFrame(() => $('commandPaletteInput').focus());
  } else if (id === 'shortcutsDialog') {
    $('shortcutsFilter').value = '';
    renderShortcutGuide();
    requestAnimationFrame(() => $('shortcutsFilter').focus());
  }
}

function closeNativeDialog(id) {
  const dialog = $(id);
  if (!dialog) return;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

function restoreDialogFocus(id) {
  const target = dialogReturnFocus.get(id);
  dialogReturnFocus.delete(id);
  if (target && target.isConnected && typeof target.focus === 'function') requestAnimationFrame(() => target.focus());
}

function renderShortcutGuide() {
  const query = $('shortcutsFilter').value.trim().toLowerCase();
  const list = $('shortcutsList');
  list.replaceChildren();
  const matches = APP_KEYBOARD_SHORTCUTS.filter((item) => (item.label + ' ' + item.detail + ' ' + item.keys).toLowerCase().includes(query));
  $('shortcutsEmpty').hidden = matches.length > 0;
  for (const item of matches) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    const copy = document.createElement('div');
    copy.className = 'shortcut-copy';
    const label = document.createElement('strong');
    label.textContent = item.label;
    const detail = document.createElement('span');
    detail.textContent = item.detail;
    copy.append(label, detail);
    const key = document.createElement('kbd');
    key.textContent = displayShortcut(item.keys);
    row.append(copy, key);
    list.appendChild(row);
  }
}

function renderCommandPalette() {
  const results = $('commandPaletteResults');
  const items = searchAppCommands($('commandPaletteInput').value).filter((item) => !item.runtimeOnly || (RT && !RT.needsToken));
  results.replaceChildren();
  commandPaletteSelected = 0;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'command-empty';
    empty.textContent = 'No matching actions. Try another search.';
    results.appendChild(empty);
    return;
  }
  for (const [index, item] of items.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'command-result';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === commandPaletteSelected));
    button.dataset.commandId = item.id;
    const text = document.createElement('span');
    text.className = 'command-result-copy';
    const label = document.createElement('strong');
    label.textContent = item.label;
    const description = document.createElement('span');
    description.textContent = item.description;
    text.append(label, description);
    const meta = document.createElement('span');
    meta.className = 'command-result-meta';
    const section = document.createElement('small');
    section.textContent = item.section;
    meta.appendChild(section);
    if (item.shortcut) {
      const key = document.createElement('kbd');
      key.textContent = displayShortcut(item.shortcut);
      meta.appendChild(key);
    }
    button.append(text, meta);
    button.addEventListener('click', () => runPaletteCommand(item.id));
    results.appendChild(button);
  }
  updatePaletteSelection();
}

// Saves the current chat as the standalone page /export FILE.html writes.
async function downloadChat() {
  if (!RT || RT.needsToken) { toast('Downloading a chat needs OASIS running on a computer (oasis web).'); return; }
  const id = agent && agent.sessionId;
  if (!id) { toast('Send a message first; there is nothing to download yet.'); return; }
  try {
    const html = await RT.client.exportSession(id);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    link.download = 'oasis-chat-' + new Date().toISOString().slice(0, 10) + '.html';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    toast('Chat downloaded.');
  } catch (error) { toast(error.message || 'Could not download this chat.'); }
}

function updatePaletteSelection() {
  const buttons = [...$('commandPaletteResults').querySelectorAll('.command-result')];
  if (!buttons.length) return;
  commandPaletteSelected = (commandPaletteSelected + buttons.length) % buttons.length;
  buttons.forEach((button, index) => button.setAttribute('aria-selected', String(index === commandPaletteSelected)));
  buttons[commandPaletteSelected].scrollIntoView({ block: 'nearest' });
}

function runPaletteCommand(id) {
  const actions = {
    'new-chat': () => newChat(),
    'open-chats': () => openChats(),
    'open-files': () => toggleFiles(true),
    'open-plugins': () => { renderPluginGrid(); openSheet('pluginsSheet'); },
    'open-settings': () => openSettings(),
    'approval-mode': () => $('modeChip').click(),
    'focus-composer': () => $('input').focus(),
    'keyboard-help': () => requestAnimationFrame(() => openNativeDialog('shortcutsDialog')),
    'export-chat': () => downloadChat(),
    'open-terminal': () => { toggleFiles(true); showPanelTab('terminal'); }
  };
  closeNativeDialog('commandPaletteDialog');
  const action = actions[id];
  if (action) setTimeout(() => action(), 0);
}

$('commandPaletteButton').addEventListener('click', () => openNativeDialog('commandPaletteDialog'));
$('commandPaletteClose').addEventListener('click', () => closeNativeDialog('commandPaletteDialog'));
$('shortcutsClose').addEventListener('click', () => closeNativeDialog('shortcutsDialog'));
$('commandPaletteInput').addEventListener('input', renderCommandPalette);
$('shortcutsFilter').addEventListener('input', renderShortcutGuide);
$('transcript').addEventListener('click', onTranscriptClick);
$('commandPaletteInput').addEventListener('keydown', (event) => {
  const buttons = $('commandPaletteResults').querySelectorAll('.command-result');
  if (event.key === 'ArrowDown' && buttons.length) { event.preventDefault(); commandPaletteSelected = (commandPaletteSelected + 1) % buttons.length; updatePaletteSelection(); }
  else if (event.key === 'ArrowUp' && buttons.length) { event.preventDefault(); commandPaletteSelected = (commandPaletteSelected - 1 + buttons.length) % buttons.length; updatePaletteSelection(); }
  else if (event.key === 'Enter' && buttons.length) { event.preventDefault(); buttons[commandPaletteSelected].click(); }
});
for (const id of ['commandPaletteDialog', 'shortcutsDialog']) {
  $(id).addEventListener('click', (event) => { if (event.target === $(id)) closeNativeDialog(id); });
  $(id).addEventListener('close', () => restoreDialogFocus(id));
}

/* ---------- Sheets ---------- */
const openSheets = [];
function openSheet(id) {
  const el = $(id);
  el.hidden = false;
  $('backdrop').hidden = false;
  openSheets.push(id);
  try { history.pushState({ sheet: id }, ''); } catch { /* sandboxed frames */ }
  const focusable = el.querySelector('input,select,textarea,button:not([data-close])');
  if (focusable && matchMedia('(pointer:fine)').matches) focusable.focus();
}
let ignorePop = false;
function closeSheet(id, { fromHistory = false } = {}) {
  const el = $(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  if (!fromHistory && history.state && history.state.sheet === id) { ignorePop = true; history.back(); }
  openSheets.splice(openSheets.indexOf(id), 1);
  if (!openSheets.length) $('backdrop').hidden = true;
  if (id === 'approvalSheet' && approvalResolve) { approvalResolve(false); approvalResolve = null; }
  if (id === 'questionSheet' && questionResolve) { questionResolve(''); questionResolve = null; }
}
document.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-close]');
  if (closer) {
    const id = closer.dataset.close;
    if (id === 'filesPanel') toggleFiles(false); else closeSheet(id);
  }
});
$('backdrop').addEventListener('click', () => { const top = openSheets[openSheets.length - 1]; if (top && top !== 'approvalSheet') closeSheet(top); });
document.addEventListener('keydown', (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (!$('shortcutsDialog').open) openNativeDialog('commandPaletteDialog');
    return;
  }
  if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === '`' || event.code === 'Backquote') && RT && !RT.needsToken) {
    event.preventDefault();
    toggleTerminal();
    return;
  }
  if (modifier && event.key === '/') {
    event.preventDefault();
    if ($('commandPaletteDialog').open) closeNativeDialog('commandPaletteDialog');
    openNativeDialog('shortcutsDialog');
    return;
  }
  // Connected to OASIS on a computer, / types a command with inline suggestions
  // (as in the terminal); in the browser-only app it opens the palette.
  if (event.key === '/' && event.target === $('input') && !$('input').value && !event.altKey && !modifier && !event.isComposing && !(RT && !RT.needsToken)) {
    event.preventDefault();
    openNativeDialog('commandPaletteDialog');
    return;
  }
  if (event.key === 'Escape') {
    if ($('commandPaletteDialog').open || $('shortcutsDialog').open) return; // Native dialog handles Escape.
    if (!$('modeMenu').hidden) { $('modeMenu').hidden = true; return; }
    const top = openSheets[openSheets.length - 1];
    if (top) closeSheet(top);
    else if (!$('filesPanel').hidden && innerWidth < 1024) toggleFiles(false);
  }
});

// The system back button and gesture (Android, browsers, desktop mice): each
// open sheet adds a history entry, so Back closes the top sheet instead of
// leaving the app.
function closeTopLayer() {
  if (!$('modeMenu').hidden) { $('modeMenu').hidden = true; return true; }
  const top = openSheets[openSheets.length - 1];
  if (top && top !== 'approvalSheet') { closeSheet(top, { fromHistory: true }); return true; }
  if (top) return true;
  if (!$('filesPanel').hidden && innerWidth < 1024) { toggleFiles(false); return true; }
  return false;
}
addEventListener('popstate', () => { if (ignorePop) { ignorePop = false; return; } if (openSheets.length || !$('modeMenu').hidden) closeTopLayer(); });

/* ---------- Agent ---------- */
const deviceAgent = new Agent({
  getConfig: () => ({ ...providerConfig(), maxSteps: settings.maxSteps }),
  getContext: () => ({
    workspace,
    sandbox,
    skills,
    github: settings.githubToken ? new GitHub({ token: settings.githubToken }) : null,
    onChange: () => refreshFiles()
  }),
  approve: requestApproval,
  onEvent: handleEvent,
  onModelFailure: (error, config) => {
    if (settings.autoSwitch === false) return null;
    const connection = settings.connections.find((c) => c.id === config.connectionId);
    if (!connection) return null;
    failedModels[connection.id + '|' + config.model] = Date.now();
    const chain = buildChain({ ...settings, activeConnection: connection.id, activeModel: config.model }, { failed: failedModels });
    const next = nextInChain(chain, { connection, model: config.model }, error, { failed: failedModels });
    if (!next) return null;
    setActive(next.connection.id, next.model);
    return configFor(next, { mode: currentMode() });
  }
});

let agent = deviceAgent;

const SWITCH_REASONS = { credits: 'ran out of credit', rate: 'is rate limited', model: 'is not available', server: 'had a server error', auth: 'rejected the key', network: 'could not be reached', context: 'ran out of context room' };

async function ensureWorkspace() {
  if (workspace) return workspace;
  if (RT) throw new Error('OASIS on this computer has no folder open.');
  workspace = await Workspace.create(store, { name: 'Scratch project' });
  localStorage.setItem('oasis.project', workspace.project.id);
  skills.setWorkspace(workspace);
  updateProjectUI();
  return workspace;
}

function projectKey() { return workspace ? workspace.project.id : '_'; }
function enabledPluginIds() { return settings.projectPlugins[projectKey()] || []; }
function setPluginEnabled(id, on) {
  const ids = new Set(enabledPluginIds());
  if (on) ids.add(id); else ids.delete(id);
  settings.projectPlugins[projectKey()] = [...ids];
  saveSettings();
  renderPluginState();
}

async function send(text) {
  if (dictation.listening) dictation.stop(true);
  const message = text.trim() || (attachments.length ? 'Take a look at the attached image' + (attachments.length === 1 ? '.' : 's.') : '');
  if (!message) return;
  if (RT && RT.needsToken) { $('input').value = ''; autosize(); await connectFromText(message, { surface: 'chat' }); return; }
  if (looksLikeConnection(message)) { $('input').value = ''; autosize(); await connectFromText(message, { surface: 'chat' }); return; }
  if (!modelReady()) {
    $('welcome').hidden = false;
    $('connectInput').focus();
    showConnectLog('connectLog', [{ step: 'error', text: 'Connect a model first: paste an API key or a model link above (or right into the message box).' }]);
    return;
  }
  await ensureWorkspace();
  renderTodos([]);
  $('input').value = '';
  autosize();
  if (RT && agent.runShell && /^!\s*\S/.test(message) && !attachments.length) {
    setBusy(true);
    try { await agent.runShell(message.slice(1)); }
    catch { /* shown in the tool card */ }
    finally { setBusy(false); persistChat(); refreshFiles(); }
    if (agent.pendingShell && agent.pendingShell.length) toast('The output goes with your next message.');
    return;
  }
  const plugins = pluginsFor([...new Set([...enabledPluginIds(), ...turnPlugins])]);
  turnPlugins = [];
  renderPluginSuggest();
  setBusy(true);
  const images = attachments.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
  sentThumbs = attachments.map((item) => item.url);
  attachments = [];
  renderAttachments();
  let settle;
  turnEdited = false;
  turnSettled = new Promise((resolve) => { settle = resolve; });
  try { await agent.send(message, { maxSteps: Number(settings.maxSteps) || 40, plugins, images }); }
  catch { /* shown through the error event */ }
  finally { setBusy(false); persistChat(); refreshFiles(); settle(); if (RT) refreshRuntimeStatus().then(updateProjectUI).catch(() => {}); attention('done', message); }
}

// Switching chats stops the running turn and waits for it to wind down, so
// its last save lands in the chat it belongs to (it used to run after the
// switch and copy the old conversation into the new chat).
let turnSettled = Promise.resolve();
async function stopTurn() {
  if (!agent.busy) return;
  agent.stop();
  await Promise.race([turnSettled, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

/* ---------- Smart connect ---------- */
function showConnectLog(id, lines) {
  const log = $(id);
  if (!log) return;
  log.replaceChildren(...lines.map((line) => {
    const li = document.createElement('li');
    li.className = line.step || 'info';
    li.textContent = line.text;
    return li;
  }));
}

let connecting = false;
async function connectFromText(text, { surface = 'welcome' } = {}) {
  if (connecting) return false;
  if (RT) return runtimeConnect(text, { surface });
  const parsed = parsePaste(text);
  connecting = true;
  const lines = [];
  let note = null;
  const logId = surface === 'settings' ? 'settingsConnectLog' : 'connectLog';
  if (surface === 'chat') {
    note = addMessage('note', '');
    note.classList.add('connect-note');
    note.innerHTML = '<ol class="connect-log"></ol>';
  }
  const render = () => {
    if (note) {
      const log = note.querySelector('ol');
      log.replaceChildren(...lines.map((line) => { const li = document.createElement('li'); li.className = line.step || 'info'; li.textContent = line.text; return li; }));
      scrollDown(true);
    } else showConnectLog(logId, lines);
  };
  const onStatus = (status) => {
    const last = lines[lines.length - 1];
    if (last && last.step === status.step && (status.step === 'download' || status.step === 'test')) lines[lines.length - 1] = status;
    else lines.push(status);
    render();
  };
  for (const token of parsed.githubTokens) {
    settings.githubToken = token;
    saveSettings();
    onStatus({ step: 'ready', text: 'GitHub token ' + maskSecret(token) + ' saved on this device: private repositories and pushing now work.' });
  }
  if (!parsed.keys.length && !parsed.urls.length && !parsed.local) {
    connecting = false;
    if (parsed.githubTokens.length) { renderWelcome(); return true; }
    return false;
  }
  for (const id of ['connectButton', 'settingsConnectButton']) if ($(id)) $(id).disabled = true;
  try {
    const result = await smartConnect(text, { onStatus, known: settings.connections });
    const connection = upsertConnection(result.connection);
    connection.models = [result.model, ...connection.models.filter((m) => m !== result.model)];
    setActive(connection.id, result.model);
    for (const extra of result.notes) onStatus({ step: 'warn', text: extra });
    const backups = buildChain(settings).length - 1;
    onStatus({ step: 'ready', text: 'Locked in ' + result.model + ' on ' + connection.label + (backups > 0 ? '. ' + backups + ' backup model' + (backups === 1 ? '' : 's') + ' ready if it runs out.' : '.') });
    renderWelcome();
    renderConnections();
    if (surface !== 'settings') $('input').focus();
    if (parsed.rest && surface === 'chat') { connecting = false; await send(parsed.rest); }
    return true;
  } catch (error) {
    onStatus({ step: 'error', text: error.message });
    return false;
  } finally {
    connecting = false;
    for (const id of ['connectButton', 'settingsConnectButton']) if ($(id)) $(id).disabled = false;
  }
}

/* ---------- Runtime engine: connect and switch models ---------- */
function runtimeEntryFrom(status) {
  const provider = status && status.providerConfigured && status.provider;
  if (!provider || !provider.model) return null;
  let host = '';
  try { host = new URL(provider.baseURL).host; } catch { host = provider.provider || 'model'; }
  const known = RT && RT.models && RT.models.length ? RT.models : [];
  const models = [...new Set([provider.model, ...(status.fallbacks || []), ...known])];
  return { connection: { id: 'runtime', provider: provider.provider || '', label: RT && RT.label || labelForHost(host), baseURL: provider.baseURL, apiKey: '', models, local: /localhost|127\.0\.0\.1/.test(provider.baseURL) }, model: provider.model };
}
function labelForHost(host) {
  const known = Object.values(PRESETS).find((preset) => preset.baseURL && preset.baseURL.includes(host));
  return known ? known.label : host;
}
async function refreshRuntimeStatus() {
  if (!RT || RT.needsToken) return;
  RT.status = await RT.client.api('/api/status');
  RT.entry = runtimeEntryFrom(RT.status);
}
async function runtimeConnect(text, { surface = 'welcome' } = {}) {
  const value = String(text || '').trim();
  const lines = [];
  let note = null;
  const logId = surface === 'settings' ? 'settingsConnectLog' : 'connectLog';
  if (surface === 'chat') { note = addMessage('note', ''); note.classList.add('connect-note'); note.innerHTML = '<ol class="connect-log"></ol>'; }
  const render = () => {
    if (note) { note.querySelector('ol').replaceChildren(...lines.map((line) => { const li = document.createElement('li'); li.className = line.step || 'info'; li.textContent = line.text; return li; })); scrollDown(true); }
    else showConnectLog(logId, lines);
  };
  const say = (step, text_) => { lines.push({ step, text: text_ }); render(); };
  if (RT.needsToken) {
    const token = tokenFromPaste(value);
    if (!token) { say('error', 'Paste the link OASIS printed in your terminal (it ends in #token=…).'); return false; }
    saveRuntimeToken(token);
    delete document.documentElement.dataset.ready;
    location.reload();
    return true;
  }
  const parsed = parsePaste(value);
  if (parsed.githubTokens.length && !parsed.keys.length && !parsed.urls.length && !parsed.local) {
    say('info', 'Not needed here: OASIS on this computer uses its own git and GitHub CLI sign-in.');
    return true;
  }
  if (!parsed.keys.length && !parsed.urls.length && !parsed.local) return false;
  if (RT.status && RT.status.providerSetupAvailable === false) { say('error', 'Connect a model on the computer running OASIS. Keys are never sent over the phone link.'); return false; }
  connecting = true;
  for (const id of ['connectButton', 'settingsConnectButton']) if ($(id)) $(id).disabled = true;
  say('detect', 'Checking ' + (parsed.keys.length ? 'the key' : 'the address') + ' and finding the best model…');
  try {
    const result = await RT.client.api('/api/provider/connect', { method: 'POST', body: { text: value } });
    lines.length = 0;
    // Once it worked, one line says what happened; the checks are not news.
    for (const extra of result.notes || []) lines.push({ step: 'warn', text: extra });
    RT.models = result.models || [];
    RT.label = result.label || '';
    await refreshRuntimeStatus();
    const backups = (result.fallbacks || []).length;
    lines.push({ step: 'ready', text: 'Locked in ' + result.provider.model + ' on ' + (result.label || 'your provider') + (backups ? '. ' + backups + ' backup model' + (backups === 1 ? '' : 's') + ' ready if it runs out.' : '.') + ' Saved on this computer.' });
    render();
    updateModeUI();
    renderWelcome();
    renderConnections();
    if (surface !== 'settings') $('input').focus();
    if (parsed.rest && surface === 'chat') { connecting = false; await send(parsed.rest); }
    return true;
  } catch (error) {
    say('error', error.message);
    return false;
  } finally {
    connecting = false;
    for (const id of ['connectButton', 'settingsConnectButton']) if ($(id)) $(id).disabled = false;
  }
}
async function runtimeSwitchModel(model) {
  try {
    await RT.client.api('/api/provider/model', { method: 'POST', body: { model } });
    await refreshRuntimeStatus();
  } catch (error) { toast(error.message, 'error'); }
  updateModeUI();
  renderWelcome();
}

$('connectForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('connectInput').value.trim();
  if (!value) { $('connectInput').focus(); return; }
  connectFromText(value).then((ok) => { if (ok) $('connectInput').value = ''; });
});
// Pasting is enough: no need to press Connect or Enter.
function connectOnPaste(input, surface) {
  input.addEventListener('paste', (event) => {
    const text = (event.clipboardData || window.clipboardData).getData('text');
    if (!text || !(looksLikeConnection(text) || (RT && RT.needsToken && tokenFromPaste(text))) || input.value.trim()) return;
    event.preventDefault();
    input.value = surface === 'chat' ? '' : maskPasted(text);
    connectFromText(text.trim(), { surface }).then((ok) => { if (ok && surface !== 'chat') input.value = ''; });
  });
}
function maskPasted(text) {
  return text.split(/\s+/).map((token) => (parsePaste(token).keys.length || isGitHubToken(token) ? maskSecret(token) : token)).join(' ');
}

async function autoDetectLocal() {
  if (modelReady() || RT) return;
  const found = await scanLocal();
  if (!found.length || modelReady()) return;
  const box = $('connectFound');
  box.replaceChildren();
  for (const connection of found.slice(0, 2)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn found';
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = 'Use ' + connection.label;
    button.querySelector('span').textContent = connection.models.length + ' model' + (connection.models.length === 1 ? '' : 's') + ' on this device · best: ' + connection.models[0];
    button.addEventListener('click', () => connectFromText(connection.baseURL));
    box.appendChild(button);
  }
  box.hidden = false;
}

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  $('sendButton').setAttribute('aria-label', busy ? 'Stop' : 'Send');
  if (typeof updateSteering === 'function') updateSteering();
  $('input').placeholder = busy ? 'Add a note for OASIS while it works…' : 'Ask OASIS to build, fix or explain…';
}

function summarizeArgs(name, args = {}) {
  if (args.path) return args.path + (args.offset ? ':' + args.offset : '');
  if (args.pattern) return args.pattern + (args.path ? '  in ' + args.path : '');
  if (args.url) return args.url;
  if (args.name) return args.name;
  if (name === 'task' && args.description) return String(args.description).slice(0, 100);
  if (args.code) return String(args.code).split('\n')[0].slice(0, 80);
  if (args.command) return [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ').slice(0, 100);
  if (args.query) return String(args.query).slice(0, 80);
  if (args.summary) return String(args.summary).slice(0, 100);
  if (args.branch) return args.branch;
  if (args.todos) return args.todos.length + ' items';
  return '';
}
function activityLabel(tool) {
  const name = String(tool.name || '').toLowerCase();
  const args = tool.args || {};
  const path = String(args.path || args.file_path || args.notebook_path || '').replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) || '';
  if (['run_command', 'run_shell', 'powershell', 'auto_test'].includes(name)) {
    const command = [args.command, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' ');
    const commandParts = command.toLowerCase().split(/[ \t]+/).filter(Boolean);
    const testRunner = ['npm', 'pnpm', 'yarn', 'bun'].includes(commandParts[0]) && commandParts.some((part) => ['test', 'check', 'vitest', 'jest', 'playwright', 'mocha'].includes(part));
    const testCommand = testRunner || (commandParts[0] === 'node' && commandParts.includes('--test')) || commandParts[0] === 'pytest' || (commandParts[0] === 'go' && commandParts[1] === 'test') || (commandParts[0] === 'cargo' && commandParts[1] === 'test');
    return testCommand ? 'Ran the tests' : 'Ran commands';
  }
  if (name === 'read_file') return path ? 'Read ' + path : 'Read a file';
  if (name === 'list_files') return 'Listed project files';
  if (name === 'write_file') return path ? 'Wrote ' + path : 'Wrote a file';
  if (['edit_file', 'multi_edit', 'notebook_edit', 'apply_patch'].includes(name)) return path ? 'Edited ' + path : 'Edited files';
  if (name === 'delete_file') return path ? 'Deleted ' + path : 'Deleted a file';
  if (['grep', 'search_files', 'glob_files', 'repo_map'].includes(name)) return 'Searched the project';
  if (['web_search', 'fetch_url'].includes(name)) return 'Looked up information online';
  if (['git_diff', 'git_status', 'git_log'].includes(name)) return 'Reviewed project changes';
  if (name === 'todo_write') return 'Updated the task plan';
  if (name === 'load_skill' || name === 'read_skill_resource' || name === 'list_skills') return 'Used a skill';
  if (name === 'task') {
    const type = String(args.subagent_type || '').slice(0, 40);
    return (args.run_in_background ? 'Started ' : 'Ran ') + (type && type !== 'general-purpose' ? 'the ' + type + ' agent' : 'a subagent');
  }
  if (name === 'agent_status') return 'Checked on subagents';
  if (name === 'send_message') return 'Sent a message to a subagent';
  if (name === 'agent_stop') return 'Stopped a subagent';
  if (name === 'ask_user_question') return 'Asked you a question';
  if (name === 'exit_plan_mode') return 'Presented a plan';
  if (name === 'lsp' || name === 'diagnostics' || name === 'ide_get_diagnostics') return 'Checked for code issues';
  if (name.startsWith('mcp_')) return 'Used a connected tool (MCP)';
  return 'Completed a project step';
}

function toolCard(tool) {
  const el = document.createElement('details');
  el.className = 'tool ' + (tool.ok === undefined ? 'running' : tool.ok ? 'ok' : 'fail');
  el.dataset.id = tool.id;
  const summary = document.createElement('summary');
  summary.innerHTML = '<span class="state" aria-hidden="true"></span><span class="name"></span><span class="arg"></span><span class="tool-status"></span><span class="chevron" aria-hidden="true">›</span>';
  const status = tool.ok === undefined ? 'in progress' : tool.ok ? 'completed' : 'failed';
  const statusLabel = tool.ok === undefined ? 'Working' : tool.ok ? 'Done' : 'Failed';
  summary.querySelector('.name').textContent = activityLabel(tool);
  summary.querySelector('.arg').textContent = summarizeArgs(tool.name, tool.args);
  summary.querySelector('.tool-status').textContent = statusLabel;
  summary.setAttribute('aria-label', activityLabel(tool) + ', ' + status + '. Expand to view details.');
  const pre = document.createElement('pre');
  // Fill the output only when opened: long sessions stay light on slow phones.
  const fill = () => { pre.textContent = tool.content || (tool.ok === undefined ? 'Running…' : 'No output was returned.'); };
  if (el.open) fill();
  el.addEventListener('toggle', () => { if (el.open) fill(); });
  el.append(summary, pre);
  // A command the user typed (`!npm test`) shows its output straight away.
  if (tool.open && tool.ok !== undefined) { el.open = true; fill(); }
  return el;
}

function addMessage(role, content, at = 0) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  if (role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;
    wrap.appendChild(bubble);
  } else if (role === 'assistant') {
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = renderMarkdown(content || '');
    wrap.appendChild(body);
  } else {
    wrap.textContent = content;
  }
  if (role === 'user' || role === 'assistant') {
    messageSource.set(wrap, String(content || ''));
    wrap.appendChild(messageActions(role, at));
  }
  $('transcript').appendChild(wrap);
  $('welcome').hidden = true;
  return wrap;
}

// Copy (and, for your own messages, edit) controls under each message. The
// Markdown source is kept per message so a copy is what was written, not the
// rendered text.
const messageSource = new WeakMap();
// Compact time for the hover bar: "14:05" today, "Nov 6, 14:05" earlier.
function messageTime(at) {
  const when = new Date(at);
  const today = new Date().toDateString() === when.toDateString();
  return today ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function messageActions(role, at = 0) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  if (at > 0) {
    const time = document.createElement('time');
    time.className = 'msg-time';
    time.dateTime = new Date(at).toISOString();
    time.title = new Date(at).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
    time.textContent = messageTime(at);
    bar.appendChild(time);
  }
  const button = (action, label, path) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.action = action;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="' + path + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    bar.appendChild(b);
  };
  button('copy', 'Copy', 'M7 7V4.5A1.5 1.5 0 018.5 3h7A1.5 1.5 0 0117 4.5v7a1.5 1.5 0 01-1.5 1.5H13M4.5 7h7A1.5 1.5 0 0113 8.5v7a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 15.5v-7A1.5 1.5 0 014.5 7z');
  if (role === 'user') button('edit', 'Edit and resend', 'M12.5 4.5l3 3M4 16l1-4 8.5-8.5 3 3L8 15l-4 1z');
  return bar;
}
// After a turn that changed files on this computer, the last reply offers
// Undo, which runs /undo (files and conversation go back one turn).
let turnEdited = false;
function offerUndo() {
  for (const old of document.querySelectorAll('.msg-actions button[data-action="undo"]')) old.remove();
  if (!RT || RT.needsToken || !turnEdited) return;
  const replies = document.querySelectorAll('#transcript .msg.assistant');
  const last = replies[replies.length - 1];
  const bar = last && last.querySelector('.msg-actions');
  if (!bar) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.action = 'undo';
  b.className = 'labelled';
  b.title = 'Undo this turn: restore the files and the conversation (/undo)';
  b.setAttribute('aria-label', b.title);
  b.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5L4 8.5 7.5 12M4.5 8.5h7a4.5 4.5 0 010 9H9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Undo</span>';
  bar.appendChild(b);
}

// Tab title badge and optional desktop notification when a task finishes or
// needs you while this tab is in the background.
const BASE_TITLE = document.title;
function attention(kind, text) {
  if (!document.hidden && document.hasFocus()) return;
  document.title = (kind === 'input' ? '(Needs you) ' : '● ') + BASE_TITLE;
  if (!settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const body = kind === 'done' ? 'Finished: ' + String(text || '').replace(/\s+/g, ' ').slice(0, 120) : String(text || '');
    const note = new Notification(kind === 'done' ? 'OASIS is done' : 'OASIS needs you', { body, tag: 'oasis-' + kind, icon: 'icons/oasis-mark.svg' });
    note.onclick = () => { window.focus(); note.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}
function clearAttention() { if (!document.hidden) document.title = BASE_TITLE; }
document.addEventListener('visibilitychange', clearAttention);
window.addEventListener('focus', clearAttention);

// Dims the undone turn (the user message, its tool steps and the reply) so the
// transcript shows what no longer applies, as the conversation does after /undo.
function markTurnUndone(reply) {
  const turn = [reply];
  for (let node = reply.previousElementSibling; node; node = node.previousElementSibling) {
    turn.push(node);
    if (node.classList.contains('msg') && node.classList.contains('user')) break;
  }
  for (const node of turn) node.classList.add('undone');
  const tag = document.createElement('div');
  tag.className = 'undone-note';
  tag.textContent = 'Undone: files and conversation went back to before this turn.';
  reply.after(tag);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}
function flashCopied(button) {
  button.classList.add('copied');
  const label = button.getAttribute('aria-label');
  button.setAttribute('aria-label', 'Copied');
  if (button.classList.contains('copy')) button.textContent = 'Copied';
  setTimeout(() => { button.classList.remove('copied'); button.setAttribute('aria-label', label); if (button.classList.contains('copy')) button.textContent = 'Copy'; }, 1400);
}
function messageText(wrap) {
  if (currentTurn && currentTurn.wrap === wrap) return currentTurn.text;
  const saved = messageSource.get(wrap);
  if (saved) return saved;
  const node = wrap.querySelector('.body, .bubble');
  return node ? node.innerText : '';
}
function onTranscriptClick(event) {
  const codeCopy = event.target.closest('pre > button.copy');
  if (codeCopy) {
    const code = codeCopy.parentElement.querySelector('code');
    copyText(code ? code.textContent : '').then((ok) => ok ? flashCopied(codeCopy) : toast('Could not copy.'));
    return;
  }
  const action = event.target.closest('.msg-actions button');
  if (!action) return;
  const wrap = action.closest('.msg');
  const text = messageText(wrap);
  if (action.dataset.action === 'copy') copyText(text).then((ok) => ok ? flashCopied(action) : toast('Could not copy.'));
  else if (action.dataset.action === 'undo') {
    if (document.body.classList.contains('busy')) { toast('Wait for OASIS to finish, or stop it first.'); return; }
    action.remove();
    markTurnUndone(wrap);
    send('/undo');
  } else if (action.dataset.action === 'edit') {
    if (document.body.classList.contains('busy')) { toast('Wait for OASIS to finish, or stop it first.'); return; }
    $('input').value = text;
    autosize();
    $('input').focus();
    $('input').setSelectionRange(text.length, text.length);
  }
}

function scrollDown(force = false) {
  const chat = $('chat');
  if (force || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 220) chat.scrollTop = chat.scrollHeight;
}

let renderQueued = false;
let lastRender = 0;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  // Re-rendering Markdown is the costliest thing while streaming; space it
  // out on slow devices and for long replies.
  const gap = LITE ? 220 : currentTurn && currentTurn.text.length > 12000 ? 160 : 0;
  const wait = Math.max(0, gap - (performance.now() - lastRender));
  const run = () => requestAnimationFrame(() => {
    renderQueued = false;
    lastRender = performance.now();
    if (!currentTurn) return;
    currentTurn.body.innerHTML = renderMarkdown(currentTurn.text);
    currentTurn.body.classList.add('cursor');
    scrollDown();
  });
  if (wait) setTimeout(run, wait); else run();
}
function trimTranscript() {
  const transcript = $('transcript');
  const limit = LITE ? 80 : 240;
  while (transcript.childElementCount > limit) transcript.firstElementChild.remove();
}

function startTurn() {
  const at = Date.now();
  const wrap = addMessage('assistant', '', at);
  const body = wrap.querySelector('.body');
  const tools = document.createElement('div');
  tools.className = 'tools';
  wrap.appendChild(tools);
  currentTurn = { wrap, body, tools, text: '', entry: { role: 'assistant', content: '', tools: [], at } };
  display.push(currentTurn.entry);
}

function removeThinking() { const t = document.querySelector('.thinking'); if (t) t.remove(); }

function handleEvent(event) {
  switch (event.type) {
    case 'user': {
      const at = Date.now();
      display.push({ role: 'user', content: event.content, at, ...(event.images ? { images: event.images } : {}) });
      const el = addMessage('user', event.content, at);
      if (event.images) addImageNote(el, event.images, sentThumbs);
      sentThumbs = [];
      scrollDown(true);
      break;
    }
    case 'thinking': {
      removeThinking();
      startTurn();
      const dots = document.createElement('div');
      dots.className = 'thinking';
      dots.innerHTML = '<i></i><i></i><i></i><span>Thinking</span>';
      currentTurn.wrap.appendChild(dots);
      scrollDown();
      break;
    }
    case 'delta':
      removeThinking();
      currentTurn.text += event.delta;
      queueRender();
      break;
    case 'retry':
      // A retried request starts its reply over; drop any half-streamed text.
      if (currentTurn) { currentTurn.text = ''; currentTurn.body.innerHTML = ''; }
      toast(event.waitMs ? 'Rate limited for a moment; retrying in ' + Math.ceil(event.waitMs / 1000) + 's…' : 'Provider busy, retrying (' + event.attempt + ')…');
      break;
    case 'model_switch': {
      const kind = classifyFailure({ message: event.reason, status: Number((String(event.reason).match(/\((\d{3})\)/) || [])[1] || 0) });
      if (currentTurn) { currentTurn.text = ''; currentTurn.body.innerHTML = ''; }
      const line = event.from + ' ' + (SWITCH_REASONS[kind] || 'failed') + '. Switched to ' + event.to + ' and carried on.';
      display.push({ role: 'note', content: line });
      addMessage('note', line);
      break;
    }
    case 'assistant': {
      removeThinking();
      if (!currentTurn) startTurn();
      currentTurn.text = event.content || '';
      currentTurn.entry.content = currentTurn.text;
      messageSource.set(currentTurn.wrap, currentTurn.text);
      currentTurn.body.classList.remove('cursor');
      currentTurn.body.innerHTML = renderMarkdown(currentTurn.text);
      currentTurn.body.hidden = !currentTurn.text;
      if (!currentTurn.text && !event.toolCalls.length) currentTurn.wrap.remove();
      break;
    }
    case 'tool_start': {
      const tool = { id: event.id, name: event.name, args: event.args, ...(event.open ? { open: true } : {}) };
      currentTurn.entry.tools.push(tool);
      currentTurn.tools.appendChild(toolCard(tool));
      scrollDown();
      break;
    }
    case 'tool_result': {
      if (!currentTurn) break;
      let tool = currentTurn.entry.tools.find((t) => t.id === event.id);
      if (!tool) { tool = { id: event.id, name: event.name, args: {} }; currentTurn.entry.tools.push(tool); currentTurn.tools.appendChild(toolCard(tool)); }
      tool.ok = event.ok;
      if (event.ok !== false && /write|edit|patch|delete|move|rename|notebook/i.test(String(event.name || tool.name || ''))) turnEdited = true;
      if (RT && /^(write_file|edit_file|multi_edit|delete_file|notebook_edit|run_command|git_commit)$/.test(event.name || tool.name)) refreshFiles();
      tool.content = event.content.length > 6000 ? event.content.slice(0, 6000) + '\n…' : event.content;
      const card = currentTurn.tools.querySelector('[data-id="' + CSS.escape(event.id) + '"]');
      if (card) {
        const wasOpen = card.open;
        const replacement = toolCard(tool);
        if (wasOpen) replacement.open = true;
        card.replaceWith(replacement);
      }
      break;
    }
    case 'todos': renderTodos(event.todos); break;
    case 'usage': usageState.tokens = event.usage.input + event.usage.output; renderUsage(); break;
    case 'context': usageState.context = event; renderUsage(); break;
    case 'cost': usageState.cost = event; renderUsage(); break;
    case 'compacted': addMessage('note', event.mode === 'summary' ? 'Earlier conversation summarised to save context.' : 'Older tool output trimmed to save context.'); break;
    case 'stopped':
      removeThinking();
      if (currentTurn) currentTurn.body.classList.remove('cursor');
      addMessage('note', 'Stopped.');
      currentTurn = null;
      break;
    case 'error':
      removeThinking();
      if (currentTurn && !currentTurn.text && !currentTurn.entry.tools.length) currentTurn.wrap.remove();
      display.push({ role: 'error', content: event.message });
      addMessage('error', event.message);
      currentTurn = null;
      scrollDown(true);
      break;
    case 'done':
      removeThinking();
      if (currentTurn) messageSource.set(currentTurn.wrap, currentTurn.text);
      currentTurn = null;
      offerUndo();
      trimTranscript();
      break;
    default: break;
  }
}

// Token total plus, when the runtime reports it, how full the context window
// is (a small ring that turns amber past 70% and red past 90%).
const usageState = { tokens: 0, context: null, cost: null };
function renderUsage() {
  const el = $('usage');
  const ctx = usageState.context;
  el.replaceChildren();
  el.classList.remove('warn', 'full');
  if (ctx && ctx.window) {
    const percent = Math.max(0, Math.min(100, Math.round(ctx.percent)));
    const ring = document.createElement('span');
    ring.className = 'ctx-ring';
    ring.style.setProperty('--p', String(percent));
    el.append(ring, document.createTextNode(percent === 0 && ctx.tokens > 0 ? '<1%' : percent + '%'));
    if (percent >= 90) el.classList.add('full'); else if (percent >= 70) el.classList.add('warn');
    el.title = 'Context: ' + formatTokens(ctx.tokens) + ' of ' + formatTokens(ctx.window) + ' tokens' + (usageState.tokens ? ' · ' + formatTokens(usageState.tokens) + ' used this chat' : '') + (percent >= 70 ? '. Older work is summarised automatically, or type /compact.' : '');
  } else if (usageState.tokens) {
    el.textContent = formatTokens(usageState.tokens) + ' tok';
    el.title = formatTokens(usageState.tokens) + ' tokens used this chat';
  } else el.removeAttribute('title');
  const cost = usageState.cost;
  if (cost && cost.usd > 0) {
    const label = formatUsd(cost.usd) + (cost.partial ? '+' : '');
    el.append(document.createTextNode((el.childNodes.length ? ' · ' : '') + label));
    el.title = (el.title ? el.title + '\n' : '') + 'Estimated spend this chat: ' + label + (cost.partial ? ' (some requests used a model with no known price)' : '') + ', subagents included.';
  }
}
function formatUsd(n) { return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2); }
function formatTokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }

function renderTodos(todos) {
  const box = $('todos');
  const progress = normalizeTaskProgress(todos);
  if (!progress.total) { box.replaceChildren(); box.hidden = true; return; }

  const previous = box.querySelector('.task-progress');
  const wasOpen = previous ? previous.open : !progress.finished;
  const plan = document.createElement('details');
  plan.className = 'task-progress';
  plan.open = wasOpen;

  const summary = document.createElement('summary');
  summary.className = 'task-progress-summary';
  const heading = document.createElement('span');
  heading.className = 'task-progress-heading';
  const title = document.createElement('strong');
  title.textContent = 'Task plan';
  const caption = document.createElement('span');
  caption.className = 'task-progress-caption';
  caption.textContent = progress.finished ? 'All steps completed' : progress.activeIndex >= 0
    ? 'Working on step ' + (progress.activeIndex + 1) + ' of ' + progress.total
    : progress.completed + ' of ' + progress.total + ' steps complete';
  heading.append(title, caption);

  const count = document.createElement('span');
  count.className = 'task-progress-count';
  count.textContent = progress.completed + '/' + progress.total;
  const chevron = document.createElement('span');
  chevron.className = 'task-progress-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';
  summary.append(heading, count, chevron);

  const track = document.createElement('div');
  track.className = 'task-progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', 'Task completion');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(progress.total));
  track.setAttribute('aria-valuenow', String(progress.completed));
  track.setAttribute('aria-valuetext', progress.completed + ' of ' + progress.total + ' steps complete');
  const fill = document.createElement('span');
  fill.style.width = progress.percent + '%';
  track.appendChild(fill);

  const list = document.createElement('ol');
  list.className = 'task-progress-list';
  progress.items.forEach((todo, index) => {
    const row = document.createElement('li');
    row.className = 'task-progress-step ' + todo.status;
    if (index === progress.activeIndex) row.setAttribute('aria-current', 'step');
    const marker = document.createElement('span');
    marker.className = 'task-progress-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○';
    const label = document.createElement('span');
    label.className = 'task-progress-label';
    label.textContent = todo.content;
    const state = document.createElement('span');
    state.className = 'task-progress-state';
    state.textContent = todo.status === 'completed' ? 'Done' : todo.status === 'in_progress' ? 'In progress' : index === progress.nextIndex ? 'Up next' : 'Queued';
    row.append(marker, label, state);
    list.appendChild(row);
  });

  plan.append(summary, track, list);
  box.replaceChildren(plan);
  box.hidden = false;
}

// Chats: each project keeps a list of chats. The first chat uses the
// original 'chat:<project>' key, so chats saved before the list existed stay.
let chatId = 'main';
const chatKey = (projectId, id) => 'chat:' + projectId + (id === 'main' ? '' : ':' + id);
async function chatIndex(projectId) {
  const index = await store.getValue('chats:' + projectId).catch(() => null);
  return index && Array.isArray(index.list) ? index : { current: 'main', list: [] };
}
function chatTitle() {
  const first = display.find((entry) => entry.role === 'user' && entry.content);
  return first ? String(first.content).replace(/\s+/g, ' ').trim().slice(0, 80) : 'New chat';
}

// The latest save, so the Chats list never shows a chat as it was before
// the reply that just finished.
let chatSaving = Promise.resolve();
function persistChat() {
  // Capture which chat and what content now: a save queued behind another
  // must not pick up a chat id or transcript that changed in the meantime.
  if (!workspace) return chatSaving;
  let snapshot;
  try { snapshot = {
    projectId: workspace.project.id,
    id: chatId,
    title: chatTitle(),
    display: display.slice(-200).map((entry) => ({ ...entry, tools: entry.tools && entry.tools.map((t) => ({ ...t, content: (t.content || '').slice(0, 2000) })) })),
    messages: RT ? agent.snapshot() : agent.messages.slice(-300).map((m) => (Array.isArray(m.content) ? { ...m, content: textOf(m.content) + ' (image not kept in saved chats)' } : m)),
    ...(!RT ? { pendingSteering: agent.steering.slice(0, 20) } : {})
  }; } catch { return chatSaving; }
  const save = () => saveChat(snapshot);
  chatSaving = chatSaving.then(save, save);
  return chatSaving;
}
async function saveChat(snapshot) {
  const { projectId, id, display: trimmed } = snapshot;
  try {
    await store.setValue(chatKey(projectId, id), {
      messages: snapshot.messages,
      ...(snapshot.pendingSteering ? { pendingSteering: snapshot.pendingSteering } : {}),
      display: trimmed
    });
    const index = await chatIndex(projectId);
    // The chat open right now stays current, even if this save is for one the user just left.
    index.current = workspace && workspace.project.id === projectId ? chatId : index.current || id;
    index.list = index.list.filter((item) => item.id !== id);
    if (trimmed.length) index.list.unshift({ id, title: snapshot.title, updatedAt: Date.now() });
    index.list = index.list.slice(0, 50);
    await store.setValue('chats:' + projectId, index);
  } catch { /* storage full: chat stays in memory */ }
}

async function newChat() {
  await stopTurn();
  if (workspace) await persistChat();
  chatId = Math.random().toString(36).slice(2, 10);
  if (workspace) { const index = await chatIndex(workspace.project.id); index.current = chatId; await store.setValue('chats:' + workspace.project.id, index); }
  await restoreChat({ keepChat: true });
  renderWelcome();
  $('input').focus();
}

async function openChat(id) {
  if (!workspace || id === chatId) return;
  await stopTurn();
  await persistChat();
  chatId = id;
  const index = await chatIndex(workspace.project.id);
  index.current = id;
  await store.setValue('chats:' + workspace.project.id, index);
  await restoreChat({ keepChat: true });
}

async function deleteChats(projectId) {
  const index = await chatIndex(projectId);
  for (const item of index.list) await store.setValue(chatKey(projectId, item.id), null);
  await store.setValue(chatKey(projectId, 'main'), null);
  await store.setValue('chats:' + projectId, null);
}

async function openChats() {
  const list = $('chatList');
  list.replaceChildren();
  await chatSaving.catch(() => {});
  const index = workspace ? await chatIndex(workspace.project.id) : { list: [] };
  // A chat saved before the list existed shows up as the first entry.
  if (workspace && !index.list.some((item) => item.id === 'main')) {
    const legacy = await store.getValue(chatKey(workspace.project.id, 'main')).catch(() => null);
    const first = legacy && legacy.display && legacy.display.find((entry) => entry.role === 'user');
    if (first) index.list.push({ id: 'main', title: String(first.content).slice(0, 80), updatedAt: 0 });
  }
  $('chatsListLabel').textContent = workspace ? 'In ' + (workspace.project.name || 'this project') : 'Open a project to keep chats';
  if (!index.list.length) list.innerHTML = '<li class="empty">No chats yet. Ask OASIS something to start one.</li>';
  for (const item of index.list) {
    const li = document.createElement('li');
    li.className = 'project-item' + (item.id === chatId ? ' current' : '');
    const open = document.createElement('button');
    open.className = 'open';
    open.innerHTML = '<strong></strong><span></span>';
    open.querySelector('strong').textContent = item.title || 'Chat';
    open.querySelector('span').textContent = item.id === chatId ? 'Open now' : item.updatedAt ? new Date(item.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Earlier';
    open.addEventListener('click', async () => { closeSheet('chatsSheet'); await openChat(item.id); });
    const del = document.createElement('button');
    del.className = 'icon-btn small';
    del.setAttribute('aria-label', 'Delete chat ' + (item.title || ''));
    del.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10M8 6V4.5h4V6M6.5 6l.7 9.5h5.6l.7-9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this chat? Files are not affected.')) return;
      const current = await chatIndex(workspace.project.id);
      current.list = current.list.filter((entry) => entry.id !== item.id);
      await store.setValue(chatKey(workspace.project.id, item.id), null);
      if (item.id === chatId) { chatId = current.list[0] ? current.list[0].id : 'main'; current.current = chatId; await store.setValue('chats:' + workspace.project.id, current); await restoreChat({ keepChat: true }); }
      else await store.setValue('chats:' + workspace.project.id, current);
      openChats();
    });
    li.append(open, del);
    list.appendChild(li);
  }
  if ($('chatsSheet').hidden) openSheet('chatsSheet');
}
$('chatsButton').addEventListener('click', () => openChats());
$('newChatButton').addEventListener('click', async () => { closeSheet('chatsSheet'); await newChat(); });

async function restoreChat({ keepChat = false } = {}) {
  $('transcript').replaceChildren();
  display = [];
  agent.reset();
  renderTodos([]);
  usageState.tokens = 0; usageState.context = null; usageState.cost = null; renderUsage();
  if (!workspace) { $('welcome').hidden = false; return; }
  if (!keepChat) chatId = (await chatIndex(workspace.project.id)).current || 'main';
  const saved = await store.getValue(chatKey(workspace.project.id, chatId));
  if (saved && saved.display && saved.display.length) {
    if (RT) agent.load(saved.messages);
    else agent.load(saved.messages, saved.pendingSteering);
    display = saved.display;
    for (const entry of display) {
      const el = addMessage(entry.role, entry.content, Number(entry.at) || 0);
      if (entry.role === 'user' && entry.images) addImageNote(el, entry.images, []);
      if (entry.tools && entry.tools.length) {
        const tools = document.createElement('div');
        tools.className = 'tools';
        for (const tool of entry.tools) tools.appendChild(toolCard(tool));
        el.appendChild(tools);
        if (!entry.content) el.querySelector('.body').hidden = true;
      }
    }
    scrollDown(true);
  } else $('welcome').hidden = false;
}

/* ---------- Approvals ---------- */
let approvalResolve = null;
let approvalAlways = null;
async function requestApproval({ name, args, runtime = false }) {
  attention('input', 'OASIS needs your approval to continue.');
  const summary = $('approvalSummary');
  const detail = $('approvalDetail');
  detail.replaceChildren();
  detail.hidden = false;
  $('allowAllButton').textContent = 'Allow all edits';
  $('allowAllButton').hidden = !['write_file', 'edit_file'].includes(name) || settings.mode !== 'ask';
  approvalAlways = null;
  if (runtime) {
    // From the agent on this computer: its own wording, diff and "always" rule.
    // "WARNING — RISKY ACTION" becomes a badge; an indented line is the
    // exact command, shown as code.
    const lines = String(args.prompt || 'Allow ' + name + '?').slice(0, 1600).split('\n');
    const risky = Boolean(args.risky) || /^WARNING\b/.test(lines[0]);
    if (/^WARNING\b/.test(lines[0])) lines.shift();
    summary.replaceChildren();
    if (risky) { const badge = document.createElement('span'); badge.className = 'risk-badge'; badge.textContent = 'Risky'; summary.appendChild(badge); }
    for (const line of lines) {
      if (!line.trim()) continue;
      const el = document.createElement(/^\s{2,}\S/.test(line) ? 'code' : 'span');
      el.className = el.tagName === 'CODE' ? 'approval-command' : 'approval-line';
      el.textContent = line.trim();
      summary.appendChild(el);
    }
    if (args.diff) renderUnifiedDiff(detail, String(args.diff)); else detail.hidden = true;
    if (args.suggestion) {
      approvalAlways = 'always';
      $('allowAllButton').hidden = false;
      $('allowAllButton').textContent = 'Always allow ' + String(args.suggestion).slice(0, 60);
    }
    openSheet('approvalSheet');
    if (navigator.vibrate) try { navigator.vibrate(12); } catch { /* not supported */ }
    return new Promise((resolve) => { approvalResolve = resolve; });
  }
  const code = (text) => '<code>' + escapeHtml(text) + '</code>';
  if (name === 'edit_file') {
    summary.innerHTML = 'Edit ' + code(args.path || '');
    renderDiff(detail, lineDiff(args.old_string || '', args.new_string || ''));
  } else if (name === 'write_file') {
    const existing = workspace && (await workspace.exists(args.path || '')) ? await workspace.read(args.path) : null;
    summary.innerHTML = (existing === null ? 'Create ' : 'Overwrite ') + code(args.path || '');
    renderDiff(detail, lineDiff(existing || '', args.content || ''));
  } else if (name === 'delete_file') {
    summary.innerHTML = 'Delete ' + code(args.path || '');
    detail.hidden = true;
  } else if (name === 'fetch_url') {
    summary.innerHTML = 'Fetch ' + code(args.url || '') + ' from the web';
    detail.hidden = true;
  } else if (name === 'github_push') {
    const changes = workspace ? await workspace.changes() : [];
    summary.innerHTML = 'Push ' + changes.length + ' changed file' + (changes.length === 1 ? '' : 's') + ' to branch ' + code(args.branch || '') + (args.open_pull_request ? ' and open a pull request' : '');
    detail.innerHTML = changes.map((c) => '<div class="' + (c.status === 'deleted' ? 'del' : 'add') + '">' + c.status + ' ' + escapeHtml(c.path) + '</div>').join('') || '<div class="note">No changes</div>';
  } else {
    summary.textContent = 'Run ' + name;
    detail.textContent = JSON.stringify(args, null, 2);
  }
  openSheet('approvalSheet');
  if (navigator.vibrate) try { navigator.vibrate(12); } catch { /* not supported */ }
  return new Promise((resolve) => { approvalResolve = resolve; });
}
function answerApproval(value) {
  const resolve = approvalResolve;
  approvalResolve = null;
  closeSheet('approvalSheet');
  if (resolve) resolve(value);
}
$('allowButton').addEventListener('click', () => answerApproval(true));
$('denyButton').addEventListener('click', () => answerApproval(false));
$('allowAllButton').addEventListener('click', () => {
  if (approvalAlways) { answerApproval(approvalAlways); return; }
  allowEditsThisSession = true; updateModeUI(); answerApproval(true);
});
function renderUnifiedDiff(container, text) {
  const lines = [];
  for (const line of text.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
    if (line.startsWith('@@')) lines.push({ type: 'note', text: line });
    else if (line.startsWith('+')) lines.push({ type: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) lines.push({ type: 'del', text: line.slice(1) });
    else lines.push({ type: 'same', text: line.replace(/^ /, '') });
  }
  renderDiff(container, lines);
}

/* ---------- Questions from the agent (runtime engine) ---------- */
let questionResolve = null;
function askQuestion(question) {
  attention('input', String(question && question.question || 'OASIS has a question.').slice(0, 160));
  $('questionText').textContent = String(question.question || '').slice(0, 600);
  const box = $('questionOptions');
  box.replaceChildren();
  for (const option of (question.options || []).slice(0, 4)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn option';
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = option.label || String(option);
    button.querySelector('span').textContent = option.description || '';
    button.addEventListener('click', () => answerQuestion(option.label || String(option)));
    box.appendChild(button);
  }
  $('questionInput').value = '';
  openSheet('questionSheet');
  return new Promise((resolve) => { questionResolve = resolve; });
}
function answerQuestion(value) {
  const resolve = questionResolve;
  questionResolve = null;
  closeSheet('questionSheet');
  if (resolve) resolve(value);
}
$('questionForm').addEventListener('submit', (event) => { event.preventDefault(); answerQuestion($('questionInput').value.trim()); });

function renderDiff(container, diff) {
  const frag = document.createDocumentFragment();
  for (const line of diff.slice(0, 1500)) {
    const div = document.createElement('div');
    div.className = line.type;
    div.textContent = (line.type === 'add' ? '+ ' : line.type === 'del' ? '− ' : line.type === 'same' ? '  ' : '') + line.text;
    frag.appendChild(div);
  }
  if (diff.length > 1500) { const more = document.createElement('div'); more.className = 'note'; more.textContent = '… ' + (diff.length - 1500) + ' more lines'; frag.appendChild(more); }
  container.replaceChildren(frag);
}

function escapeHtml(text) { return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- Composer ---------- */
function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px';
}
let suggestTimer = 0;
$('input').addEventListener('input', () => {
  autosize();
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(renderPluginSuggest, 250);
});
connectOnPaste($('input'), 'chat');
connectOnPaste($('connectInput'), 'welcome');
connectOnPaste($('settingsConnectInput'), 'settings');
$('settingsConnectButton').addEventListener('click', async () => {
  const value = $('settingsConnectInput').value.trim();
  if (!value) { $('settingsConnectInput').focus(); return; }
  if (await connectFromText(value, { surface: 'settings' })) $('settingsConnectInput').value = '';
});
$('settingsConnectInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('settingsConnectButton').click(); } });
$('input').addEventListener('keydown', (event) => {
  // Shift+Tab cycles the permission mode, as in the terminal.
  if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); cycleMode(); return; }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer:fine)').matches) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (agent.busy) {
    // Typing while OASIS works adds a note to the running task (like Claude
    // Code and Codex); an empty box makes the button Stop.
    const note = $('input').value.trim();
    if (note && typeof agent.steer === 'function' && !looksLikeConnection(note)) {
      $('input').value = ''; autosize(); updateSteering();
      if (!(await agent.steer(note))) { $('input').value = note; autosize(); updateSteering(); toast('Could not queue that note. Try a shorter message or send it as a new message.'); }
      return;
    }
    agent.stop();
    return;
  }
  send($('input').value);
});
function updateSteering() {
  const steering = document.body.classList.contains('busy') && Boolean($('input').value.trim());
  document.body.classList.toggle('steering', steering);
  $('sendButton').setAttribute('aria-label', steering ? 'Send to the running task' : document.body.classList.contains('busy') ? 'Stop' : 'Send');
}
$('input').addEventListener('input', updateSteering);

/* ---------- Composer autocomplete: / commands and skills, @ files ---------- */
async function slashCommandList() {
  if (!RT || RT.needsToken) return [];
  if (!suggest.commands) suggest.commands = RT.client.api('/api/slash-commands').then((body) => Array.isArray(body && body.commands) ? body.commands : []).catch(() => { suggest.commands = null; return []; });
  return suggest.commands;
}
async function filePathList() {
  if (!workspace) return [];
  if (!suggest.files) suggest.files = workspace.paths().catch(() => []);
  return suggest.files;
}
function closeSuggest() {
  suggest.token = null; suggest.items = []; suggest.index = 0;
  $('composerSuggest').hidden = true;
  $('composerSuggest').replaceChildren();
  $('input').removeAttribute('aria-activedescendant');
  $('input').setAttribute('aria-expanded', 'false');
}
function renderSuggest() {
  const box = $('composerSuggest');
  box.replaceChildren();
  if (!suggest.items.length) { closeSuggest(); return; }
  suggest.items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'suggest-row';
    row.id = 'suggest-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === suggest.index));
    const name = document.createElement('span');
    name.className = 'suggest-name';
    const detail = document.createElement('span');
    detail.className = 'suggest-detail';
    if (suggest.token.kind === '/') {
      name.textContent = '/' + item.name;
      detail.textContent = item.description || '';
      if (item.kind && item.kind !== 'builtin') { const tag = document.createElement('span'); tag.className = 'suggest-kind'; tag.textContent = item.kind === 'skill' ? 'skill' : 'custom'; row.append(name, tag, detail); }
      else row.append(name, detail);
    } else {
      const slash = item.lastIndexOf('/');
      name.textContent = item.slice(slash + 1);
      detail.textContent = slash >= 0 ? item.slice(0, slash + 1) : '';
      row.append(name, detail);
    }
    row.addEventListener('mousedown', (event) => { event.preventDefault(); suggest.index = i; acceptSuggest(); });
    box.appendChild(row);
  });
  box.hidden = false;
  $('input').setAttribute('aria-expanded', 'true');
  $('input').setAttribute('aria-activedescendant', 'suggest-' + suggest.index);
  const active = box.children[suggest.index];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}
async function updateSuggest() {
  const input = $('input');
  const token = suggestToken(input.value, input.selectionStart);
  const seq = ++suggest.seq;
  if (!token) { closeSuggest(); return; }
  const items = token.kind === '/'
    ? rankSuggestions(await slashCommandList(), token.query, (item) => item.name, 8)
    : rankSuggestions(await filePathList(), token.query, (item) => item, 8);
  if (seq !== suggest.seq) return;
  const same = suggest.token && suggest.token.kind === token.kind && suggest.token.query === token.query;
  suggest.token = token; suggest.items = items;
  if (!same) suggest.index = 0;
  renderSuggest();
}
function acceptSuggest() {
  const item = suggest.items[suggest.index];
  if (!item || !suggest.token) return;
  const input = $('input');
  const next = applySuggestion(input.value, suggest.token, suggest.token.kind === '/' ? item.name : item);
  input.value = next.value;
  input.setSelectionRange(next.caret, next.caret);
  closeSuggest();
  autosize();
  input.focus();
}
$('input').setAttribute('aria-autocomplete', 'list');
$('input').setAttribute('aria-controls', 'composerSuggest');
$('input').addEventListener('input', updateSuggest);
$('input').addEventListener('click', updateSuggest);
$('input').addEventListener('blur', () => setTimeout(closeSuggest, 120));
// Captured on the form so it runs before the composer's own Enter-to-send.
$('composer').addEventListener('keydown', (event) => {
  if (event.target !== $('input') || $('composerSuggest').hidden || !suggest.items.length || event.isComposing) return;
  const count = suggest.items.length;
  if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) suggest.index = (suggest.index + 1) % count;
  else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) suggest.index = (suggest.index - 1 + count) % count;
  else if (event.key === 'Escape') { closeSuggest(); event.preventDefault(); event.stopImmediatePropagation(); return; }
  else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
    const item = suggest.items[suggest.index];
    // Enter on a command that is already typed in full sends it.
    if (event.key === 'Enter' && suggest.token.kind === '/' && item && item.name.toLowerCase() === suggest.token.query.toLowerCase()) { closeSuggest(); return; }
    acceptSuggest();
  } else return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!$('composerSuggest').hidden) renderSuggest();
}, true);

function updateModeUI() {
  const mode = providerConfig().mode;
  $('modeChip').dataset.mode = mode;
  $('modeLabel').textContent = mode === 'auto' ? 'Full auto' : mode === 'edits' ? 'Auto edit' : mode === 'plan' ? 'Plan' : 'Ask first';
  for (const button of $('modeMenu').querySelectorAll('button')) button.setAttribute('aria-checked', String(button.dataset.mode === mode));
  const entry = activeEntry();
  $('modelChip').textContent = entry ? entry.model.split('/').pop().replace(/:free$/, ' (free)') : (innerWidth < 440 ? 'Connect' : 'Connect a model');
  $('modelChip').classList.toggle('empty', !entry);
  $('modelChip').title = entry ? entry.connection.label + ' · ' + entry.model : 'Paste an API key or model link to connect';
}

/* ---------- Model menu ---------- */
function positionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, rect.top - menu.offsetHeight - 8) + 'px';
}
function renderModelMenu() {
  const menu = $('modelMenu');
  menu.replaceChildren();
  const entry = activeEntry();
  if (!entry) {
    const button = document.createElement('button');
    button.innerHTML = '<strong>Connect a model</strong><span>Paste a key or link in the message box</span>';
    button.addEventListener('click', () => { menu.hidden = true; $('input').focus(); });
    menu.appendChild(button);
    return;
  }
  const seen = new Set();
  const rows = [];
  if (!RT) for (const item of buildChain(settings, { limit: 10 })) rows.push(item);
  for (const model of entry.connection.models.slice(0, 12)) rows.push({ connection: entry.connection, model });
  for (const item of rows) {
    const key = item.connection.id + '|' + item.model;
    if (seen.has(key)) continue;
    seen.add(key);
    const button = document.createElement('button');
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(item.connection.id === entry.connection.id && item.model === entry.model));
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = item.model;
    button.querySelector('span').textContent = item.connection.label + (failedModels[key] ? ' · failed recently' : '');
    button.addEventListener('click', () => { setActive(item.connection.id, item.model); menu.hidden = true; toast('Using ' + item.model); });
    menu.appendChild(button);
    if (seen.size >= 14) break;
  }
  const toggle = document.createElement('label');
  toggle.className = 'menu-toggle';
  toggle.hidden = Boolean(RT);
  toggle.innerHTML = '<input type="checkbox"> Switch automatically if a model fails';
  toggle.querySelector('input').checked = settings.autoSwitch !== false;
  toggle.querySelector('input').addEventListener('change', (event) => { settings.autoSwitch = event.target.checked; saveSettings(); });
  const manage = document.createElement('button');
  manage.innerHTML = '<strong>Manage models…</strong>';
  manage.addEventListener('click', () => { menu.hidden = true; openSettings(); });
  menu.append(toggle, manage);
}
$('modelChip').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = $('modelMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  renderModelMenu();
  menu.hidden = false;
  positionMenu(menu, $('modelChip'));
});
$('modeChip').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = $('modeMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.hidden = false;
  const rect = $('modeChip').getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, rect.top - menu.offsetHeight - 8) + 'px';
});
$('modeMenu').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (!button) return;
  settings.mode = button.dataset.mode;
  allowEditsThisSession = false;
  saveSettings();
  updateModeUI();
  $('modeMenu').hidden = true;
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#modeMenu')) $('modeMenu').hidden = true;
  if (!event.target.closest('#modelMenu')) $('modelMenu').hidden = true;
});

/* ---------- Welcome ---------- */
const SUGGESTIONS = [
  'Explain how this project is organised',
  'Find and fix a bug, then prove the fix with a test',
  'Write tests for the main module and run them',
  'Build a small to-do web app in index.html'
];
function renderWelcome() {
  const ready = modelReady();
  const entry = activeEntry();
  $('connectForm').hidden = ready;
  $('welcomeTitle').textContent = RT && RT.needsToken ? 'Paste your OASIS link.' : ready ? 'What should we build?' : 'Paste a key to start.';
  $('connectInput').placeholder = RT && RT.needsToken ? 'Paste the link from your terminal' : 'Paste a key or link';
  $('connectHint').hidden = Boolean(RT && RT.needsToken);
  $('welcomeLede').textContent = RT && RT.needsToken
    ? 'OASIS is running on this computer. Paste the link it printed in your terminal to connect this window.'
    : ready
      ? (RT ? 'Working in ' + (RT.status.workspaceName || 'this folder') + ' with ' + entry.model + '. Describe what you want in plain words.' : 'Using ' + entry.model + ' on ' + entry.connection.label + '. Describe what you want in plain words.')
      : RT
        ? 'OASIS finds the provider, picks the best model and saves it on this computer. Then it works right in ' + (RT.status.workspaceName || 'this folder') + '.'
        : 'OASIS finds the provider, picks the best model and sets everything up. It runs on this device; your code and keys go only to the model provider.';
  if (!ready) autoDetectLocal().catch(() => {});
  const steps = $('setupSteps');
  steps.replaceChildren();
  // Before a model is connected the paste box is the only thing to do; after,
  // only the optional project step is left, so the screen stays short.
  const shown = ready && !workspace && !RT ? [{ title: 'Open a project (optional)', sub: 'From GitHub, a folder or a zip. Or just ask: OASIS starts a scratch project.', action: () => openProjects() }] : [];
  steps.hidden = !shown.length;
  shown.forEach((item) => {
    const button = document.createElement('button');
    button.className = 'step';
    button.innerHTML = '<span class="num"></span><span><strong></strong><span class="sub"></span></span>';
    button.querySelector('.num').textContent = '+';
    button.querySelector('strong').textContent = item.title;
    button.querySelector('.sub').textContent = item.sub;
    button.addEventListener('click', item.action);
    steps.appendChild(button);
  });
  const box = $('suggestions');
  box.replaceChildren();
  if (ready) for (const text of SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.className = 'suggestion';
    chip.textContent = text;
    chip.addEventListener('click', () => { $('input').value = text; autosize(); renderPluginSuggest(); $('input').focus(); });
    box.appendChild(chip);
  }
}

/* ---------- Plugins ---------- */
const ICON_PATHS = {
  bug: 'M7 6a3 3 0 016 0M5.5 8h9v4.5a4.5 4.5 0 01-9 0zM10 8v9M3 10h2.5M14.5 10H17M3.5 15l2.3-1.2M16.5 15l-2.3-1.2M4 5.5l2 1.5M16 5.5L14 7',
  check: 'M4 10.5l4 4 8-9',
  eye: 'M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5zM10 12.3a2.3 2.3 0 100-4.6 2.3 2.3 0 000 4.6z',
  shield: 'M10 2.5l6 2.3v4.6c0 3.9-2.5 6.6-6 8.1-3.5-1.5-6-4.2-6-8.1V4.8zM7.3 10l2 2 3.5-3.8',
  globe: 'M10 17.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM2.5 10h15M10 2.5c2 2.1 3 4.6 3 7.5s-1 5.4-3 7.5c-2-2.1-3-4.6-3-7.5s1-5.4 3-7.5z',
  plug: 'M7 2.5v4M13 2.5v4M5 6.5h10v3a5 5 0 01-10 0zM10 14.5v3',
  phone: 'M6.5 2.5h7a1 1 0 011 1v13a1 1 0 01-1 1h-7a1 1 0 01-1-1v-13a1 1 0 011-1zM9 15h2',
  book: 'M3.5 4.5c2.5-1 4.7-1 6.5.5 1.8-1.5 4-1.5 6.5-.5v11c-2.5-1-4.7-1-6.5.5-1.8-1.5-4-1.5-6.5-.5zM10 5v11',
  branch: 'M6 3.5v13M6 16.5a1.8 1.8 0 100-3.6M14 3.5a1.8 1.8 0 110 3.6 1.8 1.8 0 010-3.6zM14 7.1c0 4-8 3-8 6'
};
function pluginIcon(name) {
  return '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="' + (ICON_PATHS[name] || ICON_PATHS.plug) + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function pluginTile(plugin) {
  const on = enabledPluginIds().includes(plugin.id);
  const tile = document.createElement('div');
  tile.className = 'plugin-tile' + (on ? ' on' : '');
  tile.dataset.plugin = plugin.id;
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'plugin-head';
  head.setAttribute('aria-pressed', String(on));
  head.innerHTML = '<span class="plugin-icon" aria-hidden="true"></span><span class="plugin-text"><strong></strong><span></span></span><span class="plugin-state"></span>';
  head.querySelector('.plugin-icon').innerHTML = pluginIcon(plugin.icon);
  head.querySelector('strong').textContent = plugin.name;
  head.querySelector('.plugin-text span').textContent = plugin.description;
  head.querySelector('.plugin-state').textContent = on ? 'On' : 'Off';
  head.addEventListener('click', () => setPluginEnabled(plugin.id, !enabledPluginIds().includes(plugin.id)));
  tile.appendChild(head);
  const starters = document.createElement('div');
  starters.className = 'plugin-starters';
  for (const starter of plugin.starters) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggestion';
    chip.textContent = starter;
    chip.addEventListener('click', () => runStarter(plugin, starter));
    starters.appendChild(chip);
  }
  tile.appendChild(starters);
  return tile;
}
function runStarter(plugin, starter) {
  closeSheet('pluginsSheet');
  if (plugin.actions && plugin.actions.includes('github') && !settings.githubToken && /push|pull request/i.test(starter)) {
    toast('Paste a GitHub token (ghp_… or github_pat_…) into the message box first.');
    $('input').focus();
    return;
  }
  turnPlugins = [plugin.id];
  if (!modelReady()) { $('input').value = starter; autosize(); renderPluginSuggest(); send(starter); return; }
  send(starter);
}
function renderPluginGrid() {
  const grid = $('pluginGrid');
  grid.replaceChildren(...PLUGINS.map((plugin) => pluginTile(plugin)));
}
function renderPluginState() {
  const count = enabledPluginIds().length;
  $('pluginCount').textContent = count ? String(count) : '';
  $('pluginCount').hidden = !count;
  if (!$('pluginsSheet').hidden) renderPluginGrid();
  renderPluginSuggest();
}
function renderPluginSuggest() {
  const box = $('pluginSuggest');
  const text = $('input').value;
  const active = new Set([...enabledPluginIds(), ...turnPlugins]);
  const picks = text.trim().length >= 6 && !looksLikeConnection(text) ? suggestPlugins(text, { active: [...active], limit: 2 }) : [];
  const pinned = turnPlugins.map(getPlugin).filter(Boolean);
  box.replaceChildren();
  for (const plugin of pinned) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggest-chip on';
    chip.textContent = plugin.name + ' ✓';
    chip.title = 'This plugin is used for your next message. Tap to remove.';
    chip.addEventListener('click', () => { turnPlugins = turnPlugins.filter((id) => id !== plugin.id); renderPluginSuggest(); });
    box.appendChild(chip);
  }
  for (const plugin of picks) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggest-chip';
    chip.textContent = 'Use ' + plugin.name;
    chip.title = plugin.description;
    chip.addEventListener('click', () => { turnPlugins = [...new Set([...turnPlugins, plugin.id])]; renderPluginSuggest(); $('input').focus(); });
    box.appendChild(chip);
  }
  box.hidden = !box.childElementCount;
}
$('pluginsButton').addEventListener('click', () => { renderPluginGrid(); openSheet('pluginsSheet'); });
$('composerPlugins').addEventListener('click', () => { renderPluginGrid(); openSheet('pluginsSheet'); });

/* ---------- Settings sheet ---------- */
function fillProviderOptions() {
  const select = $('providerSelect');
  select.replaceChildren(...Object.entries(PRESETS).map(([id, preset]) => new Option(preset.label, id)));
}
function renderConnections() {
  const list = $('connectionList');
  list.replaceChildren();
  const connections = RT ? (RT.entry ? [RT.entry.connection] : []) : settings.connections;
  if (!connections.length) {
    list.innerHTML = '<li class="empty">No models yet. Paste an API key, a model page link or a server address below.</li>';
    return;
  }
  const entry = activeEntry();
  for (const connection of connections) {
    const li = document.createElement('li');
    li.className = 'connection' + (entry && entry.connection.id === connection.id ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'connection-info';
    info.innerHTML = '<strong></strong><span></span>';
    info.querySelector('strong').textContent = connection.label;
    info.querySelector('span').textContent = (RT ? 'saved on this computer · ' : connection.apiKey ? maskSecret(connection.apiKey) + ' · ' : connection.local ? 'on this network · ' : '') + connection.models.length + ' model' + (connection.models.length === 1 ? '' : 's');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Model for ' + connection.label);
    select.append(...connection.models.slice(0, 80).map((model) => new Option(model, model)));
    select.value = entry && entry.connection.id === connection.id ? entry.model : connection.models[0];
    select.addEventListener('change', () => { connection.models = [select.value, ...connection.models.filter((m) => m !== select.value)]; setActive(connection.id, select.value); renderConnections(); });
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn small';
    use.textContent = entry && entry.connection.id === connection.id ? 'In use' : 'Use';
    use.disabled = Boolean(entry && entry.connection.id === connection.id);
    use.addEventListener('click', () => { setActive(connection.id, select.value); renderConnections(); renderWelcome(); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn small ghost';
    remove.textContent = 'Remove';
    remove.hidden = Boolean(RT);
    remove.addEventListener('click', () => {
      settings.connections = settings.connections.filter((c) => c !== connection);
      if (settings.activeConnection === connection.id) { settings.activeConnection = settings.connections[0]?.id || ''; settings.activeModel = settings.connections[0]?.models[0] || ''; }
      saveSettings();
      updateModeUI();
      renderConnections();
      renderWelcome();
    });
    const actions = document.createElement('div');
    actions.className = 'row';
    actions.append(select, use, remove);
    li.append(info, actions);
    list.appendChild(li);
  }
}
function openSettings() {
  renderConnections();
  const entry = activeEntry();
  const provider = entry ? entry.connection.provider : 'openrouter';
  $('providerSelect').value = PRESETS[provider] ? provider : 'custom';
  $('baseUrlInput').value = entry ? entry.connection.baseURL : PRESETS.openrouter.baseURL;
  $('modelInput').value = entry ? entry.model : PRESETS.openrouter.model;
  $('keyInput').value = entry ? entry.connection.apiKey : '';
  $('keyInput').placeholder = PRESETS[provider]?.keyHint || '';
  $('providerNote').textContent = PRESETS[provider]?.note || '';
  $('manualSetup').open = false;
  $('autoSwitch').checked = settings.autoSwitch !== false;
  $('settingsConnectLog').replaceChildren();
  $('modeSelect').value = currentMode() === 'edits' && settings.mode === 'ask' ? 'ask' : currentMode();
  $('maxStepsInput').value = settings.maxSteps;
  $('themeSelect').value = settings.theme;
  $('notifyInput').checked = Boolean(settings.notify) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  $('notifyInput').closest('label').hidden = typeof Notification === 'undefined';
  $('githubToken').value = settings.githubToken;
  $('testResult').textContent = '';
  $('versionLabel').textContent = APP_VERSION;
  for (const id of ['manualSetup', 'githubSettings', 'maxStepsField']) if ($(id)) $(id).hidden = Boolean(RT);
  $('autoSwitch').closest('label').hidden = Boolean(RT);
  $('runtimeInfo').hidden = !RT;
  if (RT && RT.status) $('runtimeInfo').textContent = 'Running on this computer in ' + (RT.status.workspacePath || RT.status.workspaceName) + '. Model keys are saved by OASIS on this computer, and backup models take over automatically.';
  $('wipeAll').hidden = Boolean(RT);
  $('phoneSettings').hidden = !(RT && RT.client && RT.phone);
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(({ usage, quota }) => { $('storageInfo').textContent = 'Using ' + (usage / 1048576).toFixed(1) + ' MB of ' + (quota / 1073741824).toFixed(1) + ' GB available on this device.'; });
  openSheet('settingsSheet');
}
$('providerSelect').addEventListener('change', () => {
  const preset = PRESETS[$('providerSelect').value];
  $('baseUrlInput').value = preset.baseURL;
  $('modelInput').value = preset.model;
  $('keyInput').placeholder = preset.keyHint || '';
  $('providerNote').textContent = preset.note || '';
});
$('toggleKey').addEventListener('click', () => {
  const input = $('keyInput');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('toggleKey').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
function manualDraft() {
  const provider = $('providerSelect').value;
  return { provider, protocol: PRESETS[provider].protocol, baseURL: $('baseUrlInput').value.trim().replace(/\/+$/, ''), model: $('modelInput').value.trim(), apiKey: $('keyInput').value.trim() };
}
function formSettings() {
  return {
    ...settings,
    autoSwitch: $('autoSwitch').checked,
    mode: $('modeSelect').value,
    maxSteps: Math.min(200, Math.max(5, Number($('maxStepsInput').value) || 40)),
    theme: $('themeSelect').value,
    notify: $('notifyInput').checked,
    githubToken: $('githubToken').value.trim()
  };
}
$('notifyInput').addEventListener('change', async (event) => {
  if (!event.target.checked || typeof Notification === 'undefined') return;
  const permission = Notification.permission === 'default' ? await Notification.requestPermission().catch(() => 'denied') : Notification.permission;
  if (permission !== 'granted') { event.target.checked = false; toast('Notifications are blocked for this page. Allow them in your browser\'s site settings.'); }
});
$('testButton').addEventListener('click', async () => {
  const draft = manualDraft();
  const out = $('testResult');
  out.className = 'test-result';
  out.textContent = 'Testing…';
  try {
    const result = await testProvider({ protocol: draft.protocol, baseURL: draft.baseURL, apiKey: draft.apiKey, model: draft.model });
    out.className = 'test-result ok';
    out.textContent = result.toolCalling ? 'Connected. Tool calling works.' : 'Connected, but the model did not call the test tool. OASIS will still try to read its tool calls from text.';
  } catch (error) {
    out.className = 'test-result fail';
    out.textContent = error.message;
  }
});
$('settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  settings = formSettings();
  const draft = manualDraft();
  if (!RT && $('manualSetup').open && draft.model && draft.baseURL) {
    const entry = activeEntry();
    const unchanged = entry && entry.connection.baseURL === draft.baseURL && entry.connection.apiKey === draft.apiKey && entry.model === draft.model;
    if (!unchanged) {
      const connection = upsertConnection({ id: 'c' + Date.now().toString(36), provider: draft.provider, label: PRESETS[draft.provider].label, protocol: draft.protocol, baseURL: draft.baseURL, apiKey: draft.apiKey, models: [draft.model], local: /localhost|127\.0\.0\.1|192\.168\.|\.local\b/.test(draft.baseURL), addedAt: Date.now() });
      connection.models = [draft.model, ...connection.models.filter((m) => m !== draft.model)];
      settings.activeConnection = connection.id;
      settings.activeModel = draft.model;
    }
  }
  saveSettings();
  applyTheme();
  updateModeUI();
  updateProjectUI();
  renderWelcome();
  closeSheet('settingsSheet');
  toast(RT ? 'Settings saved.' : 'Settings saved on this device.');
});
$('clearChat').addEventListener('click', async () => {
  await stopTurn();
  agent.reset();
  display = [];
  if (workspace) await store.setValue(chatKey(workspace.project.id, chatId), null);
  await persistChat();
  await restoreChat({ keepChat: true });
  renderWelcome();
  closeSheet('settingsSheet');
});
$('wipeAll').addEventListener('click', async () => {
  if (!confirm('Erase all projects, chats, keys and settings stored by OASIS on this device?')) return;
  localStorage.clear();
  await new Promise((resolve) => { const req = indexedDB.deleteDatabase('oasis-universal'); req.onsuccess = req.onerror = req.onblocked = resolve; });
  if ('caches' in window) for (const key of await caches.keys()) await caches.delete(key);
  delete document.documentElement.dataset.ready;
  location.reload();
});

/* ---------- Projects ---------- */
async function openProjects() {
  const list = $('projectList');
  list.replaceChildren();
  if (RT) { openRuntimeProjects(); return; }
  const projects = await store.listProjects();
  if (!projects.length) list.innerHTML = '<li class="empty">No projects yet.</li>';
  for (const project of projects) {
    const li = document.createElement('li');
    li.className = 'project-item' + (workspace && workspace.project.id === project.id ? ' current' : '');
    const open = document.createElement('button');
    open.className = 'open';
    open.innerHTML = '<strong></strong><span></span>';
    open.querySelector('strong').textContent = project.name;
    const source = project.source && project.source.type === 'github' ? 'GitHub ' + project.source.owner + '/' + project.source.repo : project.source && project.source.type || 'local';
    open.querySelector('span').textContent = source + ' · ' + new Date(project.updatedAt).toLocaleDateString();
    open.addEventListener('click', async () => { await switchProject(project.id); closeSheet('projectsSheet'); });
    const del = document.createElement('button');
    del.className = 'icon-btn small';
    del.setAttribute('aria-label', 'Delete ' + project.name);
    del.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10M8 6V4.5h4V6M6.5 6l.7 9.5h5.6l.7-9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm('Delete "' + project.name + '" and its chat from this device?')) return;
      await store.deleteProject(project.id);
      await deleteChats(project.id);
      if (workspace && workspace.project.id === project.id) { workspace = null; localStorage.removeItem('oasis.project'); await restoreChat(); updateProjectUI(); refreshFiles(); }
      openProjects();
    });
    li.append(open, del);
    list.appendChild(li);
  }
  if ($('projectsSheet').hidden) openSheet('projectsSheet');
}

// Runtime engine: one real folder on this computer, plus GitHub clones made
// with the computer's own GitHub CLI sign-in.
function openRuntimeProjects() {
  const list = $('projectList');
  $('deviceImport').hidden = true;
  $('projectsListLabel').textContent = 'On this computer';
  const root = RT.rootPath || (RT.status && RT.status.workspacePath) || '';
  const current = RT.status && RT.status.workspacePath;
  const rows = [{ name: root.split(/[\\/]/).filter(Boolean).pop() || root, path: root }];
  if (current && current !== root) rows.push({ name: RT.status.workspaceName, path: current });
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'project-item' + (row.path === current ? ' current' : '');
    const open = document.createElement('button');
    open.className = 'open';
    open.innerHTML = '<strong></strong><span></span>';
    open.querySelector('strong').textContent = row.name;
    open.querySelector('span').textContent = row.path;
    open.addEventListener('click', async () => {
      if (row.path !== current && row.path === root) {
        try { await RT.client.api('/api/workspace/reset', { method: 'POST', body: {} }); await useRuntimeFolder(); }
        catch (error) { toast(error.message, 'error'); return; }
      }
      closeSheet('projectsSheet');
    });
    li.append(open);
    list.appendChild(li);
  }
  const hint = document.createElement('li');
  hint.className = 'empty';
  hint.textContent = 'To work in another folder, run oasis web there' + (navigator.userAgent.includes('Electron') ? ', or use File → Open Folder.' : '.');
  list.appendChild(hint);
  if ($('projectsSheet').hidden) openSheet('projectsSheet');
}
async function useRuntimeFolder() {
  await persistChat();
  await refreshRuntimeStatus();
  workspace = new RuntimeWorkspace(RT.client, RT.status);
  updateProjectUI();
  await restoreChat();
  renderWelcome();
  renderPluginState();
  refreshFiles();
}
async function runtimeCloneRepo(value) {
  const ref = parseRepo(value);
  if (!ref) { toast('Use owner/name or a github.com URL.', 'error'); return; }
  if (agent.busy) { toast('Stop the current task first.'); return; }
  const bar = $('importProgress');
  bar.hidden = false;
  bar.firstElementChild.style.width = '30%';
  try {
    const started = await RT.client.api('/api/github/clone', { method: 'POST', body: { repository: ref.owner + '/' + ref.repo } });
    for (let i = 0; i < 600; i++) {
      const job = await RT.client.api('/api/jobs/' + started.jobId);
      if (job.status === 'completed') break;
      if (job.status === 'error' || job.status === 'cancelled') throw new Error(job.error || 'Could not open ' + ref.owner + '/' + ref.repo + '.');
      bar.firstElementChild.style.width = Math.min(95, 30 + i * 3) + '%';
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await useRuntimeFolder();
    closeSheet('projectsSheet');
    $('repoInput').value = '';
    toast('Opened ' + ref.owner + '/' + ref.repo + ' on this computer.');
  } catch (error) { toast(error.message, 'error'); }
  finally { bar.hidden = true; }
}

async function switchProject(id) {
  if (agent.busy) { toast('Stop the current task first.'); return; }
  await persistChat();
  const project = await store.getProject(id);
  if (!project) return;
  workspace = new Workspace(store, project);
  await workspace.load();
  localStorage.setItem('oasis.project', id);
  skills.setWorkspace(workspace);
  allowEditsThisSession = false;
  updateModeUI();
  updateProjectUI();
  await restoreChat();
  renderWelcome();
  renderPluginState();
  refreshFiles();
}

async function createProject(name, source, files, note) {
  const ws = await Workspace.create(store, { name, source, files });
  await switchProject(ws.project.id);
  closeSheet('projectsSheet');
  toast(note || 'Opened ' + name + ' with ' + files.length + ' files.');
}

$('projectButton').addEventListener('click', () => openProjects());
$('settingsButton').addEventListener('click', () => openSettings());
$('githubForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $('repoInput').value.trim();
  if (RT) { await runtimeCloneRepo(value); return; }
  const ref = parseRepo(value);
  if (!ref) { toast('Use owner/name or a github.com URL.', 'error'); return; }
  const bar = $('importProgress');
  bar.hidden = false;
  bar.firstElementChild.style.width = '4%';
  try {
    const gh = new GitHub({ token: settings.githubToken });
    const result = await gh.importRepo(value, { onProgress: (done, total) => { bar.firstElementChild.style.width = Math.round((done / Math.max(1, total)) * 100) + '%'; } });
    await createProject(ref.repo, result.source, result.files, 'Opened ' + ref.owner + '/' + ref.repo + ': ' + result.files.length + ' files' + (result.skipped.length ? ', skipped ' + result.skipped.length + ' binary or large files' : '') + '.');
    $('repoInput').value = '';
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    bar.hidden = true;
  }
});
$('newProject').addEventListener('click', async () => {
  const name = prompt('Project name', 'New project');
  if (name === null) return;
  await createProject(name.trim() || 'New project', { type: 'local' }, [], 'Created ' + (name.trim() || 'New project') + '.');
});
$('pickFolder').addEventListener('click', () => $('folderInput').click());
$('pickFiles').addEventListener('click', () => $('filesInput').click());

const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|\.next|target|__pycache__|\.venv|venv)\//;
async function filesFromInput(fileList) {
  const files = [];
  let skipped = 0;
  for (const file of fileList) {
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    if (/\.zip$/i.test(path) && fileList.length === 1) {
      for (const entry of await readZip(await file.arrayBuffer())) {
        if (SKIP_DIRS.test(entry.path) || entry.bytes.length > 1048576 || entry.bytes.subarray(0, 8000).includes(0)) { skipped++; continue; }
        files.push({ path: entry.path, content: new TextDecoder().decode(entry.bytes) });
      }
      return { files, skipped, name: path.replace(/\.zip$/i, '') };
    }
    if (SKIP_DIRS.test(path) || file.size > 1048576) { skipped++; continue; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.subarray(0, 8000).includes(0)) { skipped++; continue; }
    files.push({ path, content: new TextDecoder().decode(bytes) });
  }
  // A picked folder arrives as name/...; strip that shared top folder.
  const tops = new Set(files.map((f) => f.path.split('/')[0]));
  let name = 'Local files';
  if (tops.size === 1 && files.every((f) => f.path.includes('/'))) {
    name = [...tops][0];
    for (const f of files) f.path = f.path.slice(name.length + 1);
  }
  return { files, skipped, name };
}
for (const id of ['folderInput', 'filesInput']) {
  $(id).addEventListener('change', async (event) => {
    const input = event.target;
    if (!input.files || !input.files.length) return;
    try {
      const { files, skipped, name } = await filesFromInput(input.files);
      if (workspace && id === 'filesInput' && !/\.zip$/i.test(input.files[0].name) && confirm('Add these files to "' + workspace.project.name + '"? Cancel creates a new project.')) {
        for (const f of files) await workspace.write(f.path, f.content);
        refreshFiles();
        closeSheet('projectsSheet');
        toast('Added ' + files.length + ' files.');
      } else await createProject(name, { type: 'device' }, files, 'Opened ' + name + ': ' + files.length + ' files' + (skipped ? ', skipped ' + skipped + ' binary or large files' : '') + '.');
    } catch (error) { toast(error.message, 'error'); }
    input.value = '';
  });
}

function updateProjectUI() {
  $('projectName').textContent = workspace ? workspace.project.name : RT ? 'This computer' : 'No project';
  const branch = RT && RT.status && RT.status.branch;
  $('projectBranch').hidden = !branch;
  $('projectBranch').textContent = branch || '';
  $('projectBranch').title = branch ? 'Git branch: ' + branch : '';
  const github = workspace && workspace.project.source && workspace.project.source.type === 'github';
  $('pushButton').hidden = !github || Boolean(RT);
  $('exportButton').hidden = Boolean(RT);
  $('newFileButton').hidden = Boolean(RT);
  $('terminalTab').hidden = !(RT && !RT.needsToken);
  if ($('terminalTab').hidden && !$('terminalView').hidden) showPanelTab('files');
  $('panelFoot').hidden = (!$('terminalView').hidden) || ($('exportButton').hidden && $('pushButton').hidden);
}

/* ---------- Files panel ---------- */
function toggleFiles(force) {
  const panel = $('filesPanel');
  const show = force === undefined ? panel.hidden : force;
  panel.hidden = !show;
  localStorage.setItem('oasis.files', show ? '1' : '0');
  if (show) refreshFiles();
}
$('filesButton').addEventListener('click', () => toggleFiles());
// Drag (or arrow keys on) the panel's left edge to resize it; the width is remembered.
const PANEL_MIN = 280;
function setPanelWidth(px) {
  const width = Math.round(Math.max(PANEL_MIN, Math.min(px, Math.max(PANEL_MIN, innerWidth * 0.6))));
  document.documentElement.style.setProperty('--panel-w', width + 'px');
  return width;
}
{
  const saved = Number(localStorage.getItem('oasis.panelWidth'));
  if (saved >= PANEL_MIN) setPanelWidth(saved);
  const handle = $('panelResize');
  const save = () => localStorage.setItem('oasis.panelWidth', String(Math.round($('filesPanel').getBoundingClientRect().width)));
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    const move = (e) => setPanelWidth(innerWidth - e.clientX);
    const up = () => { handle.classList.remove('dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); save(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const now = $('filesPanel').getBoundingClientRect().width;
    setPanelWidth(now + (event.key === 'ArrowLeft' ? 24 : -24));
    save();
  });
  handle.addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--panel-w'); localStorage.removeItem('oasis.panelWidth'); });
}
function showPanelTab(name) {
  for (const other of document.querySelectorAll('#filesPanel .tab')) { other.classList.toggle('active', other.dataset.tab === name); other.setAttribute('aria-selected', String(other.dataset.tab === name)); }
  $('fileList').hidden = name !== 'files';
  $('changesList').hidden = name !== 'changes';
  $('terminalView').hidden = name !== 'terminal';
  $('fileFilter').parentElement.hidden = name !== 'files';
  $('panelFoot').hidden = name === 'terminal' || ($('exportButton').hidden && $('pushButton').hidden);
  if (name === 'terminal') void openTerminal();
}
for (const tab of document.querySelectorAll('#filesPanel .tab')) tab.addEventListener('click', () => showPanelTab(tab.dataset.tab));

/* ---------- Terminal (connected to OASIS on a computer) ---------- */
let terminal = null;
let xterm = null;
let fitTerminal = null;
function termTheme() {
  return { background: '#0B100C', foreground: '#E6EDE4', cursor: '#9BFF55', selectionBackground: '#9BFF5540' };
}
async function openTerminal() {
  if (!RT || RT.needsToken) { $('terminalStatus').textContent = 'Connect to OASIS on a computer to use a terminal.'; return; }
  if (!xterm) {
    try { await loadXterm(); } catch (error) { $('terminalStatus').textContent = error.message; return; }
    const Fit = globalThis.FitAddon && (globalThis.FitAddon.FitAddon || globalThis.FitAddon);
    xterm = new globalThis.Terminal({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, cursorBlink: true, convertEol: false, scrollback: 5000, theme: termTheme() });
    if (typeof Fit === 'function') { const fit = new Fit(); xterm.loadAddon(fit); fitTerminal = () => { try { fit.fit(); } catch { /* hidden */ } }; }
    xterm.open($('terminalHost'));
    xterm.onData((data) => { if (terminal) void terminal.write(data); });
    xterm.onResize(({ cols, rows }) => { if (terminal) void terminal.resize(cols, rows); });
    new ResizeObserver(() => { if (!$('terminalView').hidden && fitTerminal) fitTerminal(); }).observe($('terminalHost'));
  }
  requestAnimationFrame(() => { if (fitTerminal) fitTerminal(); xterm.focus(); });
  const saved = sessionStorage.getItem('oasis.terminal');
  if (saved && !(terminal && terminal.running)) {
    ensureTerminal();
    if (await terminal.attach(saved)) { setTerminalRunning(true); $('terminalStatus').textContent = 'Reconnected · running'; void terminal.resize(xterm.cols, xterm.rows); }
    else sessionStorage.removeItem('oasis.terminal');
  }
}
function setTerminalRunning(running) {
  $('terminalStart').hidden = running;
  $('terminalStop').hidden = !running;
}
$('terminalStart').addEventListener('click', async () => {
  if (!RT || RT.needsToken) return;
  await openTerminal();
  if (!xterm) return;
  ensureTerminal();
  const shell = (RT.status && RT.status.terminalShell) || '/bin/sh';
  $('terminalStart').disabled = true;
  try {
    if (fitTerminal) fitTerminal();
    terminal.size = { cols: xterm.cols, rows: xterm.rows };
    const id = await terminal.start(shell, []);
    if (id) {
      sessionStorage.setItem('oasis.terminal', id);
      setTerminalRunning(true);
      $('terminalStatus').textContent = shell.split(/[\\/]/).pop() + ' · running';
      void terminal.resize(xterm.cols, xterm.rows);
      xterm.focus();
    }
  } catch (error) { $('terminalStatus').textContent = error.message || String(error); }
  finally { $('terminalStart').disabled = false; }
});
function ensureTerminal() {
  if (!terminal) {
    terminal = new RuntimeTerminal({
      client: RT.client,
      approve: requestApproval,
      onStatus: (text) => { $('terminalStatus').textContent = text; },
      onOutput: (data, { truncated }) => { if (truncated) xterm.writeln('\r\n[older output dropped]'); xterm.write(data); },
      onExit: (code, { lost = false } = {}) => {
        setTerminalRunning(false);
        if (lost) return; // The shell may still be running; reopening the tab reattaches.
        sessionStorage.removeItem('oasis.terminal');
        xterm.writeln('\r\n\x1b[2m[process exited]\x1b[0m');
      }
    });
  }
}
$('terminalStop').addEventListener('click', () => { if (terminal) void terminal.stop(); });
function toggleTerminal() {
  if (!RT || RT.needsToken) return;
  const panel = $('filesPanel');
  const onTerminal = !panel.hidden && !$('terminalView').hidden;
  if (onTerminal) { toggleFiles(false); $('input').focus(); return; }
  toggleFiles(true);
  showPanelTab('terminal');
}
$('fileFilter').addEventListener('input', () => refreshFiles());

let refreshQueued = false;
function refreshFiles() {
  if (refreshQueued) return;
  refreshQueued = true;
  suggest.files = null;
  setTimeout(async () => {
    refreshQueued = false;
    const changes = workspace ? await workspace.changes() : [];
    const status = new Map(changes.map((c) => [c.path, c.status]));
    $('changesBadge').hidden = !changes.length;
    $('changesBadge').textContent = String(changes.length);
    $('changesCount').textContent = changes.length ? String(changes.length) : '';
    if ($('filesPanel').hidden) return;
    const list = $('fileList');
    list.replaceChildren();
    if (!workspace) { list.innerHTML = '<p class="empty">Open a project to see its files.</p>'; $('changesList').innerHTML = ''; return; }
    const filter = $('fileFilter').value.trim().toLowerCase();
    const paths = (await workspace.paths()).filter((p) => !filter || p.toLowerCase().includes(filter));
    if (!paths.length) list.innerHTML = '<p class="empty">' + (filter ? 'No files match.' : 'No files yet. Ask OASIS to create some.') + '</p>';
    if (RT && workspace.cache && workspace.cache.length >= 5000) { const more = document.createElement('p'); more.className = 'empty'; more.textContent = 'Showing the first 5,000 files. Filter to find others.'; list.appendChild(more); }
    const frag = document.createDocumentFragment();
    for (const path of paths.slice(0, 3000)) frag.appendChild(fileRow(path, status.get(path)));
    list.appendChild(frag);
    const changesList = $('changesList');
    changesList.replaceChildren();
    if (!changes.length) changesList.innerHTML = '<p class="empty">' + (RT ? 'No uncommitted changes.' : 'No changes since this project was opened.') + '</p>';
    for (const change of changes) changesList.appendChild(fileRow(change.path, change.status));
  }, 60);
}
function fileRow(path, status) {
  const row = document.createElement('button');
  row.className = 'file-row';
  const slash = path.lastIndexOf('/');
  const dir = document.createElement('span');
  dir.className = 'dir';
  dir.textContent = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = document.createElement('span');
  base.textContent = path.slice(slash + 1);
  row.append(dir, base);
  if (status) { const tag = document.createElement('span'); tag.className = 'tag ' + status; tag.textContent = status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M'; tag.title = status; row.appendChild(tag); }
  row.addEventListener('click', () => openEditor(path, status));
  return row;
}

let editingPath = null;
async function openEditor(path, status) {
  editingPath = path;
  if (RT) {
    // Read-only viewer: OASIS on this computer edits the real files.
    $('editorTitle').textContent = path;
    let content = '';
    try { content = status === 'deleted' ? '' : await workspace.read(path); }
    catch (error) { content = error.message; }
    $('editor').value = content;
    $('editor').readOnly = true;
    for (const id of ['revertButton', 'deleteFileButton', 'saveFileButton']) $(id).hidden = true;
    $('diffToggle').hidden = !status;
    $('diffView').hidden = true; $('editorSheet').classList.remove('fit');
    $('editor').hidden = false;
    $('diffToggle').textContent = 'Diff';
    openSheet('editorSheet');
    if (status) showDiff();
    return;
  }
  $('editor').readOnly = false;
  const files = await workspace.load();
  const file = files.get(path);
  $('editorTitle').textContent = path;
  $('editor').value = file && !file.deleted ? file.content : '';
  $('editor').readOnly = Boolean(file && file.deleted);
  $('diffToggle').hidden = !status;
  $('revertButton').hidden = !status;
  $('deleteFileButton').hidden = Boolean(file && file.deleted);
  $('saveFileButton').hidden = Boolean(file && file.deleted);
  $('diffView').hidden = true; $('editorSheet').classList.remove('fit');
  $('editor').hidden = false;
  $('diffToggle').textContent = 'Diff';
  if (status === 'deleted') showDiff();
  openSheet('editorSheet');
}
async function showDiff() {
  if (RT) {
    let lines = workspace.fileDiff(editingPath);
    if (!lines.length) lines = $('editor').value.split('\n').map((text) => ({ type: 'add', text }));
    renderDiff($('diffView'), lines);
    $('diffView').hidden = false; $('editorSheet').classList.add('fit');
    $('editor').hidden = true;
    $('diffToggle').textContent = 'File';
    return;
  }
  const file = (await workspace.load()).get(editingPath);
  renderDiff($('diffView'), lineDiff(file.original || '', file.deleted ? '' : $('editor').value));
  $('diffView').hidden = false; $('editorSheet').classList.add('fit');
  $('editor').hidden = true;
  $('diffToggle').textContent = 'Edit';
}
$('diffToggle').addEventListener('click', () => { if ($('diffView').hidden) showDiff(); else { $('diffView').hidden = true; $('editorSheet').classList.remove('fit'); $('editor').hidden = false; $('diffToggle').textContent = 'Diff'; } });
$('saveFileButton').addEventListener('click', async () => { await workspace.write(editingPath, $('editor').value); refreshFiles(); toast('Saved ' + editingPath); closeSheet('editorSheet'); });
$('revertButton').addEventListener('click', async () => { if (!confirm('Revert ' + editingPath + ' to how it was when opened?')) return; await workspace.revert(editingPath); refreshFiles(); closeSheet('editorSheet'); toast('Reverted ' + editingPath); });
$('deleteFileButton').addEventListener('click', async () => { if (!confirm('Delete ' + editingPath + '?')) return; await workspace.remove(editingPath); refreshFiles(); closeSheet('editorSheet'); });
$('editor').addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); document.execCommand('insertText', false, '  '); }
  if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (!RT) $('saveFileButton').click(); }
});
$('newFileButton').addEventListener('click', async () => {
  await ensureWorkspace();
  const path = prompt('New file path', 'src/index.js');
  if (!path) return;
  try { if (!(await workspace.exists(path))) await workspace.write(path, ''); refreshFiles(); openEditor(path.replace(/^\.?\/+/, ''), 'added'); }
  catch (error) { toast(error.message, 'error'); }
});

$('downloadFileButton').addEventListener('click', async () => {
  if (!workspace || !editingPath) return;
  try {
    const content = await workspace.read(editingPath);
    const url = URL.createObjectURL(new Blob([content == null ? '' : content], { type: 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: editingPath.split('/').pop() || 'file' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (error) { toast(error.message || 'Could not download this file.', 'error'); }
});

$('exportButton').addEventListener('click', async () => {
  if (!workspace) return;
  const files = [];
  for (const path of await workspace.paths()) files.push({ path, content: await workspace.read(path) });
  const blob = new Blob([createZip(files)], { type: 'application/zip' });
  const name = workspace.project.name.replace(/[^\w.-]+/g, '-') + '.zip';
  const file = new File([blob], name, { type: 'application/zip' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer:coarse)').matches) {
    try { await navigator.share({ files: [file], title: name }); return; } catch { /* fall back to download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

$('pushButton').addEventListener('click', async () => {
  if (!settings.githubToken) { toast('Add a GitHub token in Settings first.'); openSettings(); return; }
  const changes = await workspace.changes();
  if (!changes.length) { toast('No changes to push.'); return; }
  $('pushBranch').value = workspace.project.source.workBranch || 'oasis/' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6);
  $('pushMessage').value = $('pushMessage').value || 'Update from OASIS';
  $('pushSummary').textContent = changes.length + ' changed file' + (changes.length === 1 ? '' : 's') + ' will be committed to ' + workspace.project.source.owner + '/' + workspace.project.source.repo + '.';
  openSheet('pushSheet');
});
$('pushForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Pushing…';
  try {
    const result = await new GitHub({ token: settings.githubToken }).push(workspace, { branch: $('pushBranch').value, message: $('pushMessage').value, openPullRequest: $('pushPr').checked, title: $('pushMessage').value });
    closeSheet('pushSheet');
    addMessage('note', result.summary);
    toast('Pushed.');
    refreshFiles();
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Push'; }
});

/* ---------- Boot ---------- */
async function startRuntime(found) {
  document.documentElement.classList.add('runtime');
  RT = { client: found.client, status: found.status || null, needsToken: Boolean(found.needsToken), entry: null, models: [], label: '' };
  if (RT.needsToken) {
    updateProjectUI();
    await restoreChat();
    return;
  }
  RT.rootPath = RT.status.workspacePath;
  // Sharing with a phone is managed only from the computer itself.
  RT.phone = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(location.hostname);
  // On a computer, file edits are checkpointed and undoable; approvals are
  // about commands and other actions with effects outside the files.
  const RUNTIME_MODES = { ask: 'Approve commands and risky actions. Edits can be undone.', edits: 'Also run routine file operations without asking.', auto: 'Decides on its own; asks only for risky actions.', plan: 'Reads and plans only; nothing changes until you approve the plan.' };
  for (const button of $('modeMenu').querySelectorAll('button')) { button.querySelector('span').textContent = RUNTIME_MODES[button.dataset.mode]; button.hidden = false; }
  for (const option of $('modeSelect').options) { option.textContent = { ask: 'Ask before commands (edits can be undone)', edits: 'Allow routine file operations', auto: 'Full auto (asks only for risky actions)', plan: 'Plan only (approve the plan before any change)' }[option.value]; option.hidden = false; option.disabled = false; }
  RT.entry = runtimeEntryFrom(RT.status);
  agent = new RuntimeAgent({
    client: RT.client,
    onEvent: handleEvent,
    approve: requestApproval,
    ask: askQuestion,
    getMode: () => currentMode()
  });
  workspace = new RuntimeWorkspace(RT.client, RT.status);
  updateModeUI();
  updateProjectUI();
  await restoreChat();
}

/* ---------- Updates ---------- */
// On a computer, the runtime knows whether a newer OASIS is out. One slim bar,
// never a dialog: the desktop app installs after its own confirmation, and
// `oasis web` copies the one command to run.
let updateState = null;
let updateRetries = 0;
async function checkForUpdate() {
  // Before the link's token is pasted every call is refused; the page reloads
  // with the token and checks then.
  if (!RT || !RT.client || RT.needsToken) return;
  const state = await RT.client.api('/api/app/update').catch(() => null);
  // A failed check (runtime still starting, a dropped request) is retried
  // soon instead of waiting for the 30-minute timer: 1.5, 3, 4.5, 6, 7.5 s.
  if (!state) { if (updateRetries++ < 5) setTimeout(checkForUpdate, 1500 * updateRetries); return; }
  updateRetries = 0;
  updateState = state;
  const version = state && state.latest && state.latest.version;
  let later = '';
  try { later = sessionStorage.getItem('oasis.update.later') || ''; } catch { /* private mode */ }
  const show = Boolean(state && state.available && version && state.skippedVersion !== version && later !== version);
  $('updateBar').hidden = !show;
  if (!show) return;
  $('updateTitle').textContent = 'OASIS ' + version + ' is out.';
  if (state.host === 'desktop') {
    const downloading = state.phase === 'downloading' && state.progress && state.progress.total;
    $('updateDetail').textContent = downloading ? 'Downloading… ' + Math.round(100 * state.progress.received / state.progress.total) + '%' : 'You have ' + state.current + '.';
    $('updateAction').textContent = state.canInstall ? 'Install and restart' : 'Download';
  } else {
    $('updateDetail').textContent = 'You have ' + state.current + '. Your chats and keys stay.';
    $('updateAction').textContent = 'Copy “oasis update”';
  }
}
function setupUpdates() {
  $('updateAction').addEventListener('click', async () => {
    const state = updateState;
    if (!state) return;
    if (state.host === 'desktop') {
      try { await RT.client.api('/api/app/update', { method: 'POST', body: { action: 'install' } }); toast(state.canInstall ? 'Confirm the update in the OASIS window.' : 'Opening the release page…'); }
      catch (error) { toast('Update failed: ' + error.message, 'error'); }
      return;
    }
    try { await navigator.clipboard.writeText('oasis update'); toast('Copied. Run it in a terminal, then start OASIS again.'); }
    catch { toast('Run “oasis update” in a terminal, then start OASIS again.'); }
  });
  $('updateNotes').addEventListener('click', () => {
    const state = updateState;
    const url = (state && state.latest && state.latest.url) || (state && state.releasesPage) || 'https://github.com/FAHTHIZ/oasis/releases/latest';
    if (/^https:\/\/github\.com\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  });
  $('updateLater').addEventListener('click', () => {
    try { if (updateState && updateState.latest) sessionStorage.setItem('oasis.update.later', updateState.latest.version); } catch { /* private mode */ }
    $('updateBar').hidden = true;
  });
  if (!RT) return;
  checkForUpdate();
  setInterval(() => { if (!document.hidden) checkForUpdate(); }, 30 * 60 * 1000);
}

/* ---------- Dictation ---------- */
// The browser's own speech recognition where it works (Chrome, Edge, Safari).
// Where it does not (the desktop app, Firefox) and OASIS runs on this
// computer, record here and let OASIS transcribe with the configured endpoint.
// Words land in the message box; nothing is sent until you press send.
const dictation = { listening: false, stop() {} };
function setupDictation() {
  const button = $('dictateButton');
  const input = $('input');
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const setState = (on) => {
    dictation.listening = on;
    button.classList.toggle('listening', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Stop dictation' : 'Dictate');
    button.title = on ? 'Stop dictation' : 'Dictate';
  };
  const insert = (text) => {
    const base = input.value;
    input.value = base + (base && !/\s$/.test(base) ? ' ' : '') + text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  if (Recognition && !/Electron\//.test(navigator.userAgent)) {
    button.hidden = false;
    let rec = null;
    let base = '';
    let spoken = '';
    const write = (interim) => {
      const words = (spoken + interim).replace(/\s+/g, ' ').trim();
      input.value = base + (base && words && !/\s$/.test(base) ? ' ' : '') + words;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    dictation.stop = (discard) => { if (rec) { if (discard) rec.onresult = null; try { rec.stop(); } catch { /* already stopped */ } } };
    button.addEventListener('click', () => {
      if (rec) { dictation.stop(); return; }
      rec = new Recognition();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      base = input.value;
      spoken = '';
      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) spoken += event.results[i][0].transcript + ' ';
          else interim += event.results[i][0].transcript;
        }
        write(interim);
      };
      rec.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') toast('Microphone access is blocked. Allow it in the browser to dictate.', 'error');
        else if (!['no-speech', 'aborted'].includes(event.error)) toast('Dictation stopped (' + event.error + ').', 'error');
      };
      rec.onend = () => { rec = null; setState(false); input.focus(); };
      try { rec.start(); setState(true); } catch { rec = null; setState(false); }
    });
    return;
  }
  if (!(RT && RT.client && window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return;
  button.hidden = false;
  let recorder = null;
  let discard = false;
  dictation.stop = (drop) => { discard = Boolean(drop); if (recorder && recorder.state !== 'inactive') recorder.stop(); };
  button.addEventListener('click', async () => {
    if (button.classList.contains('working')) return;
    if (recorder) { dictation.stop(); return; }
    const voice = await RT.client.api('/api/voice').catch(() => null);
    if (!voice || !voice.transcription) {
      toast(voice && voice.disabledByPolicy ? 'Dictation is turned off by your organization.' : 'Dictation needs a transcription service here: set OPENAI_API_KEY for OASIS, or see /voice in the terminal.', 'error');
      return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast('Microphone access is blocked. Allow it to dictate.', 'error'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const chunks = [];
    discard = false;
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      const mime = (recorder.mimeType || type || 'audio/webm').split(';')[0];
      recorder = null;
      stream.getTracks().forEach((track) => track.stop());
      setState(false);
      if (discard || !chunks.length) return;
      button.classList.add('working');
      try {
        const response = await fetch(RT.client.origin + '/api/transcribe', { method: 'POST', headers: { authorization: 'Bearer ' + RT.client.token, 'content-type': mime }, body: new Blob(chunks, { type: mime }), cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'error ' + response.status);
        if (data.text) insert(String(data.text).trim()); else toast('No speech was recognised.');
      } catch (error) { toast('Dictation failed: ' + error.message, 'error'); }
      finally { button.classList.remove('working'); }
    };
    recorder.start();
    setState(true);
    setTimeout(() => { if (recorder) dictation.stop(); }, 300000);
  });
}

async function boot() {
  applyTheme();
  fillProviderOptions();
  updateModeUI();
  const found = await detectRuntime().catch(() => ({ available: false }));
  if (found.available) await startRuntime(found);
  else {
    const id = localStorage.getItem('oasis.project');
    if (id && (await store.getProject(id))) await switchProject(id);
    else { await restoreChat(); updateProjectUI(); }
  }
  renderWelcome();
  renderPluginState();
  setupDictation();
  setupUpdates();
  // The side panel comes back open only where it sits beside the chat; on a
  // phone it would cover the conversation.
  if (innerWidth >= 1024 && (localStorage.getItem('oasis.files') === '1' || (localStorage.getItem('oasis.files') === null && workspace))) toggleFiles(true);
  refreshFiles();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const shared = new URLSearchParams(location.search);
  if (shared.get('repo')) { $('repoInput').value = shared.get('repo'); openProjects(); }
  if (shared.get('q')) { $('input').value = shared.get('q'); autosize(); renderPluginSuggest(); }
  if (!modelReady() && !workspace) $('connectInput').focus({ preventScroll: true });
}
// data-ready tells automation (and tests) that boot finished on this page load.
boot().catch((error) => toast(error.message, 'error')).finally(() => { document.documentElement.dataset.ready = '1'; });

// Phone link (runtime on this computer only): share this session with a phone
// over Tailscale (encrypted) or home Wi-Fi, shown as a QR code.
let phoneState = null;
function renderPhone(st) {
  phoneState = st;
  $('phoneError').textContent = '';
  if (st.mode === 'server') {
    $('phoneChoices').hidden = true; $('phoneLink').hidden = true;
    $('phoneHint').textContent = st.hint || 'This computer is already reachable on the network. Use the links printed in the terminal.';
    return;
  }
  $('phoneChoices').hidden = false;
  $('phoneTailscale').disabled = !st.tailscaleAvailable;
  $('phoneLan').disabled = !st.lanAvailable;
  const hints = [];
  if (!st.tailscaleAvailable) hints.push('For an encrypted link that also works away from home, install Tailscale on this computer and the phone and sign in on both.');
  if (!st.lanAvailable) hints.push('No home network address was found on this computer.');
  else hints.push('Wi-Fi sharing is not encrypted: use it only on your own home network.');
  $('phoneHint').textContent = hints.join(' ');
  const on = Boolean(st.active && st.urls && st.urls.length);
  $('phoneLink').hidden = !on;
  if (on) {
    // The QR is an SVG built by the runtime from the link alone.
    const svg = new DOMParser().parseFromString(st.qr || '', 'image/svg+xml').documentElement;
    $('phoneQr').replaceChildren(...(svg && svg.nodeName === 'svg' ? [document.importNode(svg, true)] : []));
    $('phoneNetwork').textContent = st.network === 'tailscale' ? 'Shared over Tailscale (encrypted).' : 'Shared over Wi-Fi (not encrypted).';
    $('phoneUrl').textContent = st.urls[0];
  }
}
async function openPhone() {
  if (!(RT && RT.client)) return;
  if (!$('settingsSheet').hidden) closeSheet('settingsSheet');
  $('phoneHint').textContent = 'Checking this computer’s networks…';
  $('phoneLink').hidden = true; $('phoneError').textContent = '';
  openSheet('phoneSheet');
  try { renderPhone(await RT.client.api('/api/phone/link')); }
  catch (error) { $('phoneHint').textContent = ''; $('phoneError').textContent = error.message; }
}
async function phoneAction(body) {
  $('phoneError').textContent = '';
  try { renderPhone(await RT.client.api('/api/phone/link', { method: 'POST', body })); }
  catch (error) { if (!/not confirmed/i.test(error.message)) $('phoneError').textContent = error.message; }
}
$('phoneButton').addEventListener('click', openPhone);
$('phoneTailscale').addEventListener('click', () => phoneAction({ action: 'start', network: 'tailscale' }));
$('phoneLan').addEventListener('click', () => {
  // The desktop app confirms with its own dialog; in a browser, confirm here.
  if (phoneState && phoneState.nativeConfirm) return phoneAction({ action: 'start', network: 'lan' });
  if (!confirm('Wi-Fi sharing is not encrypted. Anyone on the same network could watch or reuse the link. Share only on your own home network?')) return;
  return phoneAction({ action: 'start', network: 'lan', allowUnencrypted: true });
});
$('phoneStop').addEventListener('click', () => phoneAction({ action: 'stop' }));
$('phoneCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('phoneUrl').textContent); $('phoneCopy').textContent = 'Copied'; setTimeout(() => { $('phoneCopy').textContent = 'Copy link'; }, 1500); } catch {}
});
window.oasisConnectPhone = openPhone;

// Images: paste, drop or attach (up to 4). Large photos are scaled down on the
// device first, which keeps uploads small on slow connections and old phones.
let attachments = [];
let sentThumbs = [];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_IMAGE_SIDE = 1600;
function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function prepareImage(file) {
  let blob = file;
  let mediaType = file.type;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale < 1 || file.size > MAX_IMAGE_BYTES || !IMAGE_TYPES.includes(file.type)) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const keepPng = file.type === 'image/png' && file.size <= MAX_IMAGE_BYTES;
      mediaType = keepPng ? 'image/png' : 'image/jpeg';
      blob = await new Promise((resolve) => canvas.toBlob(resolve, mediaType, 0.86));
    }
    if (bitmap.close) bitmap.close();
  } catch { /* not decodable here: send as is if the type is allowed */ }
  if (!blob || !IMAGE_TYPES.includes(mediaType)) throw new Error('Use a PNG, JPEG, GIF or WebP image.');
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('That image is too large, even after scaling it down.');
  return { mediaType, data: await base64Of(blob), name: file.name || 'pasted-image', url: URL.createObjectURL(blob) };
}
async function addImages(files) {
  const list = [...files].filter((file) => file && /^image\//.test(file.type));
  if (!list.length) return false;
  for (const file of list) {
    if (attachments.length >= 4) { toast('Attach up to 4 images per message.'); break; }
    try { attachments.push(await prepareImage(file)); }
    catch (error) { toast(error.message); }
  }
  renderAttachments();
  $('input').focus();
  return true;
}
function renderAttachments() {
  const box = $('attachments');
  box.replaceChildren(...attachments.map((item, index) => {
    const tile = document.createElement('div');
    tile.className = 'attachment';
    const img = document.createElement('img');
    img.src = item.url; img.alt = item.name;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove ' + item.name);
    remove.addEventListener('click', () => { URL.revokeObjectURL(item.url); attachments.splice(index, 1); renderAttachments(); });
    tile.append(img, remove);
    return tile;
  }));
  box.hidden = !attachments.length;
}
function addImageNote(el, count, urls) {
  const bubble = el && el.querySelector('.bubble');
  if (!bubble) return;
  if (urls && urls.length) {
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    for (const url of urls) { const img = document.createElement('img'); img.src = url; img.alt = 'Attached image'; thumbs.appendChild(img); }
    bubble.prepend(thumbs);
  } else {
    const note = document.createElement('span');
    note.className = 'image-note';
    note.textContent = count + ' image' + (count === 1 ? '' : 's') + ' attached';
    bubble.prepend(note);
  }
}
$('attachButton').addEventListener('click', () => $('attachInput').click());
$('attachInput').addEventListener('change', async () => { await addImages($('attachInput').files); $('attachInput').value = ''; });
$('input').addEventListener('paste', (event) => {
  const files = event.clipboardData && event.clipboardData.files;
  if (files && [...files].some((file) => /^image\//.test(file.type))) { event.preventDefault(); addImages(files); }
});
for (const type of ['dragenter', 'dragover']) $('composer').addEventListener(type, (event) => { if ([...(event.dataTransfer && event.dataTransfer.items || [])].some((item) => item.kind === 'file')) { event.preventDefault(); $('composer').classList.add('dragging'); } });
for (const type of ['dragleave', 'drop']) $('composer').addEventListener(type, () => $('composer').classList.remove('dragging'));
$('composer').addEventListener('drop', (event) => { if (event.dataTransfer && event.dataTransfer.files.length) { event.preventDefault(); addImages(event.dataTransfer.files); } });
