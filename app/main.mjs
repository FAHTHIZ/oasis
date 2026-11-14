// OASIS universal app: UI wiring. Opened on its own, all agent work happens
// in this browser. Opened from `oasis web`, the same UI
// drives the agent on that computer (runtime engine, core/runtime.mjs).
import { PRESETS, testProvider } from './core/providers.mjs';
import { alwaysAllowLabel } from './core/approval-rule.mjs';
import { SUBAGENT_STATUS_TEXT } from './core/subagents.mjs';
import { createConnectorCard, connectIntent, splitServices, brandMark } from './core/connector-card.mjs';
import { createSoundPlayer } from './core/sound.mjs';
import { readableOutput, repeatsEarlierReply, stepOutcome, stepRan, stepLabel, summarizeArgs, toolKind, groupTitle, groupStats, formatDuration, thinkingLabel, thoughtLabel, splitTextToolCall, elapsedSince, describeInput, buildTimeline, groupTiming, runElapsed, timingSplit } from './core/timeline.mjs';
import { IndexedDBStore, Workspace, lineDiff } from './core/workspace.mjs';
import { wordHighlights } from '../src/word-diff.mjs';
import { Agent, answeredHistory, textOf } from './core/agent.mjs';
import { FrameSandbox } from './core/sandbox.mjs';
import { SkillLibrary } from './core/skills.mjs';
import { GitHub, parseRepo } from './core/github.mjs';
import { createZip, readZip } from './core/zip.mjs';
import { renderMarkdown, renderPartialMarkdown, splitStableMarkdown } from './markdown.mjs';
import { smartConnect, looksLikeConnection, parsePaste, scanLocal, buildChain, nextInChain, configFor, classifyFailure, maskSecret, isGitHubToken, serverLabel } from './core/connect.mjs';
import { PLUGINS, getPlugin, pluginsFor, suggestPlugins } from './core/plugins.mjs';
import { detectRuntime, RuntimeAgent, RuntimeWorkspace, tokenFromPaste, saveRuntimeToken, forgetRuntimeToken, deviceRemembered } from './core/runtime.mjs';
import { APP_KEYBOARD_SHORTCUTS, searchAppCommands } from './core/command-palette.mjs';
import { normalizeTaskProgress } from './core/task-progress.mjs';
import { RuntimeTerminal, loadXterm, wrapWords } from './core/terminal.mjs';
import { suggestToken, rankSuggestions, applySuggestion } from './core/composer-suggest.mjs';
import { mcpServerFromForm, describeMcpServer } from './core/mcp.mjs';
import { speakable, isStopPhrase, turnDetector, rmsLevel, lastReply } from './core/voice-mode.mjs';
import { previewTarget } from './core/preview.mjs';
import { anchorMenu } from './core/popover.mjs';
import { createFocusTrap } from 'focus-trap';
import { tinykeys } from 'tinykeys';
import { deleteDB } from 'idb';
import { icon, kindIcon } from './core/icons.mjs';
import { searchMarketplace, marketplaceCount, OFFICIAL_MARKETPLACE } from './core/claude-plugins.mjs';
import { syncBrowserChats } from './core/chat-sync.mjs';
import { initActivity, refreshActivity, focusStep, resetActivity } from './activity.mjs';
// The module graph loaded: tell the boot watchdog (boot-watchdog.js) to stand down.
document.documentElement.dataset.booted = '1';
// Composer autocomplete state (declared early: refreshFiles clears the file cache).
const suggest = { token: null, items: [], index: 0, commands: null, files: null, noFileCommand: false, seq: 0 };

const APP_VERSION = '1.3.0';
const $ = (id) => document.getElementById(id);
const store = new IndexedDBStore();
const sandbox = new FrameSandbox();
const skills = new SkillLibrary({ baseURL: new URL('skills/', location.href).href });

const DEFAULTS = { connections: [], activeConnection: '', activeModel: '', autoSwitch: true, projectPlugins: {}, mode: 'ask', maxSteps: 100, theme: 'system', githubToken: '', notify: false, sounds: false };
// Slow phones and old computers: fewer repaints while a reply streams, no
// blur or animation, and a shorter transcript kept in the page.
const sound = createSoundPlayer({ enabled: () => Boolean(settings && settings.sounds) });
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
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0C0E0D' : '#F7F7F5';
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

/* ---------- Toasts ---------- */
function toast(message, kind = '') {
  // The same note twice in a row (for example two reconnects) shows once.
  for (const old of $('toasts').children) if (old.textContent === message) old.remove();
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
    'connect-app': () => { openSettings(); requestAnimationFrame(() => { const apps = $('appSettings'); if (apps && !apps.hidden) apps.scrollIntoView({ block: 'start', behavior: 'smooth' }); }); },
    'approval-mode': () => $('modeChip').click(),
    'focus-composer': () => $('input').focus(),
    'keyboard-help': () => requestAnimationFrame(() => openNativeDialog('shortcutsDialog')),
    'export-chat': () => downloadChat(),
    'sign-out': () => { forgetRuntimeToken(); delete document.documentElement.dataset.ready; location.reload(); },
    'open-terminal': () => { toggleFiles(true); showPanelTab('terminal'); },
    'open-activity': () => toggleActivity(true)
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
$('appFilter').addEventListener('input', filterApps);
function connectCustomApp() {
  const url = $('appCustomUrl').value.trim();
  if (!/^https:\/\//i.test(url)) { toast('Use the https address of the MCP server.'); return; }
  $('appCustomUrl').value = '';
  closeSheet('settingsSheet');
  void connectShortcut('/connect ' + url, { keepInput: true });
}
$('appCustomConnect').addEventListener('click', connectCustomApp);
$('appCustomUrl').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); connectCustomApp(); } });
$('transcript').addEventListener('click', onTranscriptClick);
// Opening a step or group above the newest output keeps it where it is.
$('transcript').addEventListener('click', (event) => { const toggle = event.target.closest && event.target.closest('summary, .steps-head, .run-head'); if (toggle) follow.keepInPlace(toggle); }, true);
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
const sheetTraps = new Map();
// A docked approval sits over the chat column, just above the message box.
function placeDocked() {
  const el = $('approvalSheet');
  if (el.hidden || !el.classList.contains('docked')) return;
  const box = $('composer').getBoundingClientRect();
  // Sit above everything stacked on the message box (the run clock, waiting
  // notes, the task list), so the card never covers "Waiting for you · 12s".
  let top = box.top;
  for (const id of ['todos', 'runStatus', 'pendingInputs']) {
    const part = $(id);
    if (part && !part.hidden && part.getClientRects().length) top = Math.min(top, part.getBoundingClientRect().top);
  }
  el.style.left = Math.round(box.left) + 'px';
  el.style.width = Math.round(box.width) + 'px';
  el.style.bottom = Math.round(innerHeight - top + 8) + 'px';
  // Leave room so the last steps can scroll out from under the card.
  $('chat').style.paddingBottom = (el.offsetHeight + 16) + 'px';
  scrollDown();
}
addEventListener('resize', placeDocked);
// Opening the files panel or the sidebar moves the message box too.
if (typeof ResizeObserver === 'function') { const dockWatch = new ResizeObserver(() => placeDocked()); dockWatch.observe($('composer')); dockWatch.observe(document.querySelector('.composer-wrap')); }
function openSheet(id) {
  const el = $(id);
  el.hidden = false;
  // On wide screens an approval docks above the message box without blocking
  // the page, so the sidebar stays usable and the task keeps waiting.
  const docked = id === 'approvalSheet' && matchMedia('(min-width:1100px)').matches && !document.documentElement.classList.contains('side-hidden');
  el.classList.toggle('docked', docked);
  el.setAttribute('aria-modal', docked ? 'false' : 'true');
  if (docked) placeDocked(); else $('backdrop').hidden = false;
  openSheets.push(id);
  try { history.pushState({ sheet: id }, ''); } catch { /* sandboxed frames */ }
  // A modal sheet keeps Tab inside it and gives focus back on close (focus-trap,
  // MIT); stacked sheets pause the one below. A docked approval does not trap.
  // With a mouse the first field takes focus; on touch the sheet itself does,
  // so no keyboard pops up.
  // An approval never starts on a button (Enter would answer it unread).
  const first = matchMedia('(pointer:fine)').matches && el.querySelector(id === 'approvalSheet' ? 'input:not([hidden]),textarea:not([hidden])' : 'input:not([hidden]),select,textarea,button:not([data-close])');
  sheetTraps.get(id)?.deactivate({ returnFocus: false });
  if (docked) { if (first) first.focus(); else { if (!el.hasAttribute('tabindex')) el.tabIndex = -1; el.focus({ preventScroll: true }); } } else {
    if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
    const trap = createFocusTrap(el, { initialFocus: () => first || el, fallbackFocus: el, escapeDeactivates: false, clickOutsideDeactivates: false, allowOutsideClick: true, returnFocusOnDeactivate: true, preventScroll: true });
    sheetTraps.set(id, trap);
    trap.activate();
  }
  if (id === 'approvalSheet') { runClock.tick(); refreshWaitingRows(); }
}
let ignorePop = false;
function closeSheet(id, { fromHistory = false } = {}) {
  const el = $(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  sheetTraps.get(id)?.deactivate();
  sheetTraps.delete(id);
  if (el.classList.contains('docked')) { el.classList.remove('docked'); el.style.left = el.style.width = el.style.bottom = ''; $('chat').style.paddingBottom = ''; }
  if (!fromHistory && history.state && history.state.sheet === id) { ignorePop = true; history.back(); }
  openSheets.splice(openSheets.indexOf(id), 1);
  if (!openSheets.some((open) => !$(open).classList.contains('docked'))) $('backdrop').hidden = true;
  if (id === 'approvalSheet') { markWaitingTools(false); runClock.tick(); }
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
// App-wide shortcuts on tinykeys: modifiers must match exactly, $mod is Cmd on
// Apple devices and Ctrl elsewhere (so Ctrl+K and Ctrl+B keep their text-editing
// meaning on macOS), and KeyK-style codes work on any keyboard layout.
const inTerminal = (event) => event.target instanceof Element && Boolean(event.target.closest('.xterm'));
tinykeys(document, {
  '$mod+KeyK': (event) => {
    event.preventDefault();
    if (!$('shortcutsDialog').open) openNativeDialog('commandPaletteDialog');
  },
  // Ctrl/Cmd+Shift+A shows the activity panel; Ctrl/Cmd+B toggles the task sidebar
  // (as in VS Code). Neither fires in the terminal, where tmux and readline use them.
  '$mod+Shift+KeyA': (event) => {
    if (inTerminal(event)) return;
    event.preventDefault();
    toggleActivity();
  },
  '$mod+KeyB': (event) => {
    if (inTerminal(event) || !matchMedia('(min-width: 1100px)').matches) return;
    event.preventDefault();
    $('sidebarToggle').click();
  },
  'Control+Backquote': (event) => {
    if (!RT || RT.needsToken) return;
    event.preventDefault();
    toggleTerminal();
  },
  '$mod+[Shift]+Slash': (event) => {
    event.preventDefault();
    if ($('commandPaletteDialog').open) closeNativeDialog('commandPaletteDialog');
    openNativeDialog('shortcutsDialog');
  },
  // ? opens the shortcut list when you are not typing, as in GitHub and Gmail.
  '[Shift]+?': (event) => {
    const typing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm');
    if (typing || $('commandPaletteDialog').open || $('shortcutsDialog').open) return;
    event.preventDefault();
    openNativeDialog('shortcutsDialog');
  },
  // Connected to OASIS on a computer, / types a command with inline suggestions
  // (as in the terminal); in the browser-only app it opens the palette.
  '[Shift]+/': (event) => {
    if (event.target !== $('input') || $('input').value || (RT && !RT.needsToken)) return;
    event.preventDefault();
    openNativeDialog('commandPaletteDialog');
  },
  Escape: () => {
    if ($('commandPaletteDialog').open || $('shortcutsDialog').open) return; // Native dialog handles Escape.
    if (!$('modeMenu').hidden) { $('modeMenu').hidden = true; return; }
    const top = openSheets[openSheets.length - 1];
    if (top) closeSheet(top);
    else if (!$('filesPanel').hidden && innerWidth < 1024) toggleFiles(false);
    // Nothing else open: Esc stops the running task (finished work stays).
    else if (agent.busy && $('composerSuggest').hidden && !(talk && talk.on)) agent.stop();
  }
}, { ignore: (event) => event.isComposing });

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
  if (RT && !attachments.length && !agent.busy && await connectShortcut(message)) return;
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
  turnPage = '';
  turnSettled = new Promise((resolve) => { settle = resolve; });
  try { await agent.send(message, { maxSteps: Number(settings.maxSteps) || 100, plugins, images }); }
  catch { /* shown through the error event */ }
  finally {
    setBusy(false);
    if (!agent.detached) { persistChat(); attention('done', message); }
    refreshFiles(); refreshPreviewIfOpen(); settle(); if (RT) refreshRuntimeStatus().then(updateProjectUI).catch(() => {});
    setTimeout(flushPendingInputs, 0);
  }
}

// Switching chats stops the running turn and waits for it to wind down, so
// its last save lands in the chat it belongs to (it used to run after the
// switch and copy the old conversation into the new chat).
let turnSettled = Promise.resolve();
// Where the running turn's output starts in `display` (saved with its job id).
let turnStart = 0;
async function stopTurn() {
  if (!agent.busy) return;
  agent.stop();
  await Promise.race([turnSettled, new Promise((resolve) => setTimeout(resolve, 5000))]);
}
// Leaving a chat (switching, new task): a task on the computer keeps running
// and is picked up again when its chat is opened. Only the in-browser engine
// has to stop.
// Returns true when it detached; the chat was saved with its job id then, and
// the caller must not save it again (that would drop the job id).
async function leaveTurn() {
  if (!agent.busy) return false;
  if (!(RT && agent.detach && agent.jobId && agent.jobKind === 'agent')) { await stopTurn(); return false; }
  await persistChat();
  agent.detach();
  if (!$('approvalSheet').hidden) closeSheet('approvalSheet');
  await Promise.race([turnSettled, new Promise((resolve) => setTimeout(resolve, 5000))]);
  return true;
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
  return { connection: { id: 'runtime', provider: provider.provider || '', label: RT && RT.label || labelForHost(host, provider.baseURL), baseURL: provider.baseURL, apiKey: '', models, local: /localhost|127\.0\.0\.1/.test(provider.baseURL) }, model: provider.model };
}
function labelForHost(host, baseURL = '') {
  const known = Object.values(PRESETS).find((preset) => preset.baseURL && preset.baseURL.includes(host));
  return known ? known.label : serverLabel(baseURL) || host;
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
    saveRuntimeToken(token, globalThis, { remember: Boolean($('rememberDevice') && $('rememberDevice').checked) });
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
    // The "Checking…" line is finished; leave only the reason it failed.
    lines.length = 0;
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

/* Connected to `oasis web` with no model yet: show what fits this computer
   (hardware and local model servers, from /api/system/profile). */
let profileShown = false;
async function recommendForThisComputer() {
  if (profileShown || !RT || RT.needsToken || !RT.client || modelReady()) return;
  profileShown = true;
  let rec;
  try { rec = await RT.client.api('/api/system/profile'); } catch { return; }
  const p = rec && rec.primary;
  if (!p || modelReady()) return;
  const box = $('connectFound');
  box.replaceChildren();
  const card = document.createElement('div');
  card.className = 'recommend';
  const label = document.createElement('span');
  label.className = 'recommend-label';
  label.textContent = 'Recommended for this computer';
  const title = document.createElement('strong');
  title.textContent = p.route === 'local' ? 'Use ' + p.model + ' on ' + (p.serverName || 'your local server')
    : p.route === 'local-install' ? 'Run ' + p.model + ' privately with Ollama' : 'Use a hosted model';
  const detail = document.createElement('span');
  detail.textContent = [p.reason, p.route === 'local-install' && p.install ? 'After installing, run: ' + p.install.command : '', (rec.notes || [])[0]].filter(Boolean).join(' ');
  const hw = document.createElement('small');
  hw.textContent = rec.summary || '';
  card.append(label, title, detail, hw);
  if (p.route === 'local' && p.baseURL) {
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn small';
    use.textContent = 'Use this';
    use.addEventListener('click', () => connectFromText(p.baseURL));
    card.append(use);
  } else if (p.route === 'local-install') {
    const get = document.createElement('a');
    get.className = 'btn small';
    get.href = /^https:\/\//.test(p.install && p.install.url || '') ? p.install.url : 'https://ollama.com/download';
    get.target = '_blank';
    get.rel = 'noopener';
    get.textContent = 'Get Ollama';
    card.append(get);
  }
  box.append(card);
  box.hidden = false;
}

async function autoDetectLocal() {
  if (RT) { await recommendForThisComputer(); return; }
  if (modelReady()) return;
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
  if (typeof renderSidebar === 'function') void renderSidebar();
  $('sendButton').setAttribute('aria-label', busy ? 'Stop' : 'Send');
  if (typeof updateSteering === 'function') updateSteering();
  $('input').placeholder = busy ? 'Add a note for OASIS while it works…' : 'Ask OASIS to build, fix or explain…';
  $('activityLive').hidden = !busy;
  refreshActivity();
}

/* ---------- Timeline: prose updates and execution groups ---------- */
// The agent's work reads like Perplexity Computer's progress view: prose
// from the agent, with tool calls folded into groups between them. A group
// is open while it runs (its title says what is happening right now) and
// folds into one line when the agent moves on. Every step opens to show its
// exact input and output. Labels and grouping live in core/timeline.mjs.
const OUTCOME_WORDS = { ok: 'Done', failed: 'Failed', timed_out: 'Timed out', declined: 'Declined', blocked: 'Blocked', cancelled: 'Stopped' };
function stepStatus(tool) {
  const outcome = stepOutcome(tool);
  if (outcome === 'running') return tool.waiting ? 'Waiting for you' : 'Working';
  return OUTCOME_WORDS[outcome] || 'Done';
}
// Row state class: ok, fail (it ran and failed) or skip (it never ran).
function stepState(tool) {
  const outcome = stepOutcome(tool);
  if (outcome === 'running') return 'running';
  if (outcome === 'ok') return 'ok';
  return stepRan(tool) ? 'fail' : 'skip';
}
function stepDuration(tool) {
  // Time spent waiting for approval is not run time (the Activity row shows it apart).
  const waited = Number(tool.waitedMs) || 0;
  if (Number.isFinite(Number(tool.durationMs))) return formatDuration(Math.max(0, tool.durationMs - waited));
  if (Number.isFinite(Number(tool.startedAt)) && Number.isFinite(Number(tool.endedAt))) return formatDuration(Math.max(0, tool.endedAt - tool.startedAt - waited));
  return '';
}

// The inspector inside a step: what went in (command, diff, file) and what
// came back. Built only when opened, so long sessions stay light.
function fillInspector(box, tool) {
  const frag = document.createDocumentFragment();
  const section = (label, node, copyText) => {
    const wrap = document.createElement('div');
    wrap.className = 'inspect-section';
    const head = document.createElement('div');
    head.className = 'inspect-label';
    head.textContent = label;
    if (copyText) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy inspect-copy';
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', 'Copy ' + label.toLowerCase());
      copy.addEventListener('click', (event) => { event.stopPropagation(); copyText().then((ok) => ok ? flashCopied(copy) : toast('Could not copy.')); });
      head.appendChild(copy);
    }
    wrap.append(head, node);
    frag.appendChild(wrap);
  };
  for (const part of describeInput(tool)) {
    if (part.format === 'diff') {
      const diff = document.createElement('div');
      diff.className = 'diff inspect-diff';
      renderDiff(diff, lineDiff(part.old, part.new));
      section(part.label, diff, () => copyText(part.new));
    } else if (part.format === 'prose' || part.format === 'text' || part.format === 'path') {
      const text = document.createElement(part.format === 'path' ? 'code' : 'div');
      text.className = 'inspect-text';
      text.textContent = part.text.length > 4000 ? part.text.slice(0, 4000) + '…' : part.text;
      section(part.label, text);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'inspect-pre' + (part.format === 'command' ? ' command' : '');
      const lines = part.text.split('\n');
      pre.textContent = (part.format === 'command' ? '$ ' : '') + (lines.length > 200 ? lines.slice(0, 200).join('\n') + '\n… ' + (lines.length - 200) + ' more lines' : part.text);
      section(part.label, pre, () => copyText(part.text));
    }
  }
  const out = document.createElement('pre');
  out.className = 'inspect-pre output' + (stepState(tool) === 'fail' ? ' failed' : '');
  out.textContent = inspectorOutput(tool);
  section(stepState(tool) === 'fail' ? 'Error' : 'Output', out, () => copyText(tool.fullContent || tool.content || tool.live || ''));
  // Long results were cut for the transcript; the whole output stays on the
  // computer and loads on request.
  if (tool.more && !tool.fullContent && RT && agent && typeof agent.fetchToolOutput === 'function') {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'link-button show-full';
    more.textContent = 'Show full output';
    more.addEventListener('click', async (event) => {
      event.stopPropagation();
      more.disabled = true;
      more.textContent = 'Loading…';
      try {
        const full = await agent.fetchToolOutput(tool.id);
        tool.fullContent = String(full && full.text || '');
        out.textContent = tool.fullContent || out.textContent;
        more.remove();
        if (full && full.truncated) toast('Showing the first megabyte of output.');
      } catch {
        more.disabled = false;
        more.textContent = 'Show full output';
        toast('The full output is no longer on the computer.');
      }
    });
    frag.lastChild.appendChild(more);
  }
  box.replaceChildren(frag);
}
function inspectorOutput(tool) {
  if (tool.fullContent) return tool.fullContent;
  if (tool.ok === undefined) return tool.live ? tool.live : tool.waiting ? 'Waiting for your approval…' : 'Running…';
  return readableOutput(tool.content) || 'No output was returned.';
}

// A step row is built once and then patched in place as the step moves
// from running to its outcome: no re-mount, no re-played animation, an open
// inspector and text selection survive.
function stepRow(tool, { enter = false } = {}) {
  const item = document.createElement('li');
  item.dataset.id = tool.id;
  item.dataset.name = tool.name || '';
  item.dataset.kind = toolKind(tool.name);
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.innerHTML = '<span class="state" aria-hidden="true"></span><span class="kind-icon">' + kindIcon(toolKind(tool.name)) + '</span><span class="name"></span><span class="arg"></span><span class="tool-status"></span><span class="dur"></span><span class="chevron" aria-hidden="true">' + icon('chevron-right') + '</span>';
  const box = document.createElement('div');
  box.className = 'inspect';
  const tail = document.createElement('pre');
  tail.className = 'step-tail';
  tail.hidden = true;
  tail.setAttribute('aria-hidden', 'true');
  details.append(summary, box);
  details.addEventListener('toggle', () => { if (details.open) { fillInspector(box, item._tool || tool); addTraceLink(box, item); } });
  // A step the user opened or closed themselves keeps that state.
  summary.addEventListener('click', () => { details._singleOpened = false; });
  item.append(details, tail);
  patchStepRow(item, tool);
  if (enter) item.classList.add('enter');
  return item;
}
// "Open in Activity": the same step on the run timeline, with its timing.
function addTraceLink(box, item) {
  if (box.querySelector('.trace-link')) return;
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'trace-link';
  link.textContent = 'Open in Activity';
  link.addEventListener('click', () => { toggleActivity(true); requestAnimationFrame(() => focusStep(item.dataset.id)); });
  box.appendChild(link);
}
function patchStepRow(item, tool) {
  item._tool = tool;
  const state = stepState(tool);
  // The entrance animation plays once, on a live mount; any later patch drops it.
  item.className = 'tool ' + state + (tool.waiting ? ' waiting' : '');
  const summary = item.querySelector('summary');
  const label = stepLabel(tool);
  const set = (selector, text) => { const el = summary.querySelector(selector); if (el.textContent !== text) el.textContent = text; };
  set('.name', label);
  const argText = summarizeArgs(tool.name, tool.args);
  set('.arg', argText && label.toLowerCase().includes(argText.toLowerCase()) ? '' : argText);
  set('.tool-status', stepStatus(tool));
  set('.dur', stepDuration(tool));
  summary.setAttribute('aria-label', label + ', ' + stepStatus(tool).toLowerCase() + '. Expand to inspect input and output.');
  patchStepTail(item, tool);
  patchStepAsk(item, tool);
  const details = item.querySelector('details');
  // A command the user typed (`!npm test`) opens on its output once, when it finishes.
  if (tool.open && tool.ok !== undefined && !item._autoOpened) { item._autoOpened = true; details.open = true; }
  if (details.open) {
    const out = item.querySelector('.inspect-pre.output');
    // While running only the output changes; refill fully once it settles.
    if (out && tool.ok === undefined) out.textContent = inspectorOutput(tool);
    else { fillInspector(item.querySelector('.inspect'), tool); addTraceLink(item.querySelector('.inspect'), item); }
  }
}
// A step waiting for approval answers right in its row: Allow and Deny run
// the same path as the approval sheet, which stays open for the full detail
// and the "what to do instead" note. When the sheet is docked right above
// the message box its own buttons are in view, so the row does not repeat them.
function patchStepAsk(item, tool) {
  let ask = item.querySelector('.step-ask');
  const sheet = $('approvalSheet');
  const show = Boolean(tool.waiting) && tool.ok === undefined && !sheet.hidden && !sheet.classList.contains('docked');
  if (!show) { if (ask) ask.remove(); return; }
  if (ask) return;
  ask = document.createElement('div');
  ask.className = 'step-ask';
  ask.setAttribute('role', 'group');
  ask.setAttribute('aria-label', 'Approve this step');
  const button = (text, cls, target) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn ' + cls;
    el.textContent = text;
    el.addEventListener('click', () => $(target).click());
    return el;
  };
  ask.append(button('Deny', 'step-deny', 'denyButton'), button('Allow', 'primary step-allow', 'allowButton'));
  item.appendChild(ask);
}
// The last few lines of a running command, under its row. It goes away
// when the step finishes; the inspector keeps the whole output.
const TAIL_LINES = 5;
function patchStepTail(item, tool) {
  const tail = item.querySelector('.step-tail');
  if (!tail) return;
  const show = tool.ok === undefined && Boolean(tool.live && tool.live.trim()) && !item.querySelector('details').open;
  tail.hidden = !show;
  if (!show) { if (tail.textContent) tail.textContent = ''; return; }
  const lines = tool.live.replace(/\s+$/, '').split('\n').slice(-TAIL_LINES).map((line) => line.length > 200 ? line.slice(0, 199) + '…' : line);
  const text = lines.join('\n');
  if (tail.textContent !== text) tail.textContent = text;
}

// One execution group. `steps` is the live array of tool records; the group
// re-renders its header from it and swaps single rows as they change.
function createGroup(steps = [], { live = false } = {}) {
  const el = document.createElement('section');
  el.className = 'steps' + (live ? ' enter' : '');
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'steps-head';
  head.innerHTML = '<span class="steps-orb" aria-hidden="true"></span><span class="steps-title"></span><span class="steps-meta"></span><span class="chevron" aria-hidden="true">' + icon('chevron-right') + '</span>';
  const body = document.createElement('div');
  body.className = 'steps-body';
  body.id = 'steps-' + Math.random().toString(36).slice(2, 10);
  head.setAttribute('aria-controls', body.id);
  const list = document.createElement('ol');
  list.className = 'step-list';
  body.appendChild(list);
  el.append(head, body);
  const group = { el, head, body, list, steps, subagents: [], live, touched: false, startedAt: Date.now() };
  head.addEventListener('click', () => { group.touched = true; setGroupOpen(group, !el.classList.contains('open')); });
  for (const tool of steps) list.appendChild(stepRow(tool));
  setGroupOpen(group, live);
  updateGroupHead(group);
  return group;
}
function setGroupOpen(group, open) {
  group.el.classList.toggle('open', open);
  group.head.setAttribute('aria-expanded', String(open));
  group.body.hidden = !open;
  openSingleStep(group);
}
// A finished group of one step: its header already says what the step did,
// so opening it shows that step's input and output directly, not a second
// row with the same words.
function openSingleStep(group) {
  const details = group.list.querySelector('.tool > details');
  if (!details) return;
  if (!group.el.classList.contains('single') || !group.el.classList.contains('open')) {
    // The group grew past one step (or closed): fold back a step that only
    // opened because it was alone, so a long run does not keep it expanded.
    if (details._singleOpened) {
      details._singleOpened = false;
      details.open = false;
      // Drop the inspector it built; it is rebuilt when the step is opened again.
      const box = details.querySelector('.inspect');
      if (box) box.replaceChildren();
    }
    return;
  }
  if (!details.open) { details.open = true; details._singleOpened = true; }
}
function updateGroupHead(group) {
  const stats = groupStats(group.steps);
  const waiting = group.steps.some((step) => step.ok === undefined && step.waiting);
  const running = group.live && stats.running > 0;
  group.el.classList.toggle('running', running && !waiting);
  group.el.classList.toggle('waiting', waiting);
  group.el.classList.toggle('failed', !running && stats.failed > 0);
  group.el.classList.toggle('done', !running && !waiting);
  const single = !running && !waiting && group.steps.length === 1 && !group.subagents.length;
  if (group.el.classList.contains('single') !== single) { group.el.classList.toggle('single', single); openSingleStep(group); }
  let title = groupTitle(group.steps);
  if (waiting) title = 'Waiting for your approval';
  group.head.querySelector('.steps-title').textContent = title;
  const meta = [];
  meta.push(stats.total + (stats.total === 1 ? ' step' : ' steps'));
  if (stats.failed) meta.push(stats.failed + ' failed');
  if (stats.declined) meta.push(stats.declined + ' declined');
  if (stats.blocked) meta.push(stats.blocked + ' blocked');
  if (stats.stopped) meta.push(stats.stopped + ' stopped');
  if (group.subagents.length) meta.push(group.subagents.length + (group.subagents.length === 1 ? ' subagent' : ' subagents'));
  const timing = groupTiming(group.steps);
  const time = running || waiting ? formatDuration(timing ? timing.spanMs : 0) || elapsedSince(group.startedAt) : formatDuration(stats.durationMs);
  if (time) meta.push(time);
  group.head.querySelector('.steps-meta').textContent = meta.join(' · ');
  // Inside the open group: how much of that time was tools and how much was
  // the model working between them.
  const split = !running && !waiting && timing && timing.spanMs >= 1000 ? timingSplit(timing) : '';
  let foot = group.body.querySelector('.steps-timing');
  if (split && !foot) { foot = document.createElement('div'); foot.className = 'steps-timing'; group.body.appendChild(foot); }
  if (foot) { if (!split) foot.remove(); else if (foot.textContent !== split) foot.textContent = split; }
  group.head.setAttribute('aria-label', title + ', ' + meta.join(', ') + '. ' + (group.el.classList.contains('open') ? 'Collapse' : 'Expand') + ' steps.');
}
function updateStepRow(group, tool) {
  const row = group.list.querySelector('[data-id="' + CSS.escape(tool.id) + '"]');
  if (row) patchStepRow(row, tool);
  else group.list.appendChild(stepRow(tool, { enter: group.live }));
  updateGroupHead(group);
}
// A group stops being live when the agent speaks again or the turn ends; it
// folds away unless the user opened or closed it by hand.
function settleGroup(group) {
  if (!group || !group.live) return;
  group.live = false;
  // Verbose keeps every step list open; Normal folds finished work to one line.
  if (!group.touched && !verboseSteps()) setGroupOpen(group, false);
  updateGroupHead(group);
}
function verboseSteps() { return Boolean(settings && settings.density === 'verbose'); }

// Subagents started in a group, with their live status (running, done, failed).
function renderSubagents(group, workers = []) {
  group.subagents = workers;
  let box = group.list.querySelector('.subagents');
  if (!workers.length) { if (box) box.remove(); updateGroupHead(group); return; }
  if (!box) {
    box = document.createElement('li');
    box.className = 'subagents';
    box.setAttribute('aria-label', 'Subagents');
  }
  // Sit right under the step that started them.
  const launches = group.list.querySelectorAll('.tool[data-name="task"]');
  const anchor = launches[launches.length - 1];
  if (anchor) { if (anchor.nextSibling !== box) anchor.after(box); }
  else if (!box.parentNode) group.list.appendChild(box);
  const running = workers.filter((w) => w.status === 'running' || w.status === 'stopping').length;
  const head = document.createElement('div');
  head.className = 'subagents-head';
  head.textContent = workers.length + (workers.length === 1 ? ' subagent' : ' subagents') + (running ? ' · ' + running + ' working' : '');
  const list = document.createElement('ul');
  for (const worker of workers) {
    const item = document.createElement('li');
    item.className = 'subagent ' + worker.status;
    item.innerHTML = '<span class="state" aria-hidden="true"></span><span class="sa-name"></span><span class="sa-status"></span><span class="sa-detail"></span>';
    item.querySelector('.sa-name').textContent = worker.description || worker.id;
    item.querySelector('.sa-status').textContent = SUBAGENT_STATUS_TEXT[worker.status] || worker.status;
    item.querySelector('.sa-detail').textContent = worker.detail || '';
    list.appendChild(item);
  }
  box.replaceChildren(head, list);
  updateGroupHead(group);
}
// One timer ticks the elapsed time of live groups.
const liveGroups = new Set();
setInterval(() => {
  for (const group of liveGroups) {
    if (!group.live || !group.el.isConnected) { liveGroups.delete(group); continue; }
    updateGroupHead(group);
  }
}, 1000);

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
    // Steps that only ran tools have no text; a hidden body keeps them compact.
    body.hidden = !String(content || '').trim();
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
  const button = (action, label, name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.action = action;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = icon(name);
    bar.appendChild(b);
  };
  button('copy', 'Copy', 'copy');
  if (role === 'user') button('edit', 'Edit and resend', 'pencil');
  return bar;
}
// A failed turn (provider down, rate limit, network) offers Try again, which
// sends the same request again; the conversation already holds it, so the
// model answers it rather than seeing it twice.
function offerRetry(card) {
  let index = display.length - 1;
  while (index >= 0 && display[index].role !== 'user') index--;
  const request = index >= 0 ? String(display[index].content || '') : '';
  if (!request.trim() || request.startsWith('/')) return;
  const row = document.createElement('div');
  row.className = 'msg-actions-row';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'chip';
  retry.innerHTML = icon('rotate-ccw') + '<span>Try again</span>';
  retry.addEventListener('click', () => {
    if (document.body.classList.contains('busy')) { toast('Wait for OASIS to finish, or stop it first.'); return; }
    retryRequest(request);
  });
  row.appendChild(retry);
  card.appendChild(row);
}

function retryRequest(request) {
  // The retried request replaces the failed attempt: its message and the
  // error below it leave the transcript (the Activity panel keeps the record).
  let index = display.length - 1;
  while (index >= 0 && display[index].role !== 'user') index--;
  if (index >= 0) display.splice(index);
  const bubbles = document.querySelectorAll('#transcript > .msg.user');
  const failed = bubbles[bubbles.length - 1];
  if (failed) { while (failed.nextSibling) failed.nextSibling.remove(); failed.remove(); }
  persistChat();
  send(request);
}

// After a turn that changed files on this computer, the last reply offers
// Undo, which runs /undo (files and conversation go back one turn).
let turnEdited = false;
// The page (index.html, …) this turn wrote, so its reply can open it in Preview.
let turnPage = '';
let quietUndo = false;
function offerUndo() {
  for (const old of document.querySelectorAll('.msg-actions button[data-action="undo"], .msg-actions button[data-action="preview"]')) old.remove();
  if (!RT || RT.needsToken || !turnEdited) return;
  const replies = document.querySelectorAll('#transcript .msg.assistant');
  const last = replies[replies.length - 1];
  const bar = last && last.querySelector('.msg-actions');
  if (!bar) return;
  if (turnPage) {
    const view = document.createElement('button');
    view.type = 'button';
    view.dataset.action = 'preview';
    view.dataset.page = turnPage;
    view.className = 'labelled';
    view.title = 'Open ' + turnPage + ' in Preview';
    view.setAttribute('aria-label', view.title);
    view.innerHTML = icon('eye') + '<span>Preview</span>';
    bar.appendChild(view);
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.action = 'undo';
  b.className = 'labelled';
  b.title = 'Undo this turn: restore the files and the conversation (/undo)';
  b.setAttribute('aria-label', b.title);
  b.innerHTML = icon('undo-2') + '<span>Undo</span>';
  bar.appendChild(b);
}

// Tab title badge and optional desktop notification when a task finishes or
// needs you while this tab is in the background.
const BASE_TITLE = document.title;
function attention(kind, text) {
  if (talk.on && kind === 'input' && window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined') window.speechSynthesis.speak(new SpeechSynthesisUtterance('OASIS needs you on screen.'));
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
// Files can change outside the page (the terminal, an editor): refresh the
// file list when the user comes back, unless a task is updating it anyway.
window.addEventListener('focus', () => { if (RT && workspace && !agent.busy) refreshFiles(); });

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
  else if (action.dataset.action === 'preview') {
    // The first open of Preview loads preview.address once the server answers.
    const page = action.dataset.page;
    const loaded = preview.loaded;
    preview.address = page;
    toggleFiles(true);
    showPanelTab('preview');
    if (loaded) loadPreview(page);
  } else if (action.dataset.action === 'undo') {
    if (document.body.classList.contains('busy')) { toast('Wait for OASIS to finish, or stop it first.'); return; }
    action.remove();
    markTurnUndone(wrap);
    quietUndo = true;
    send('/undo');
  } else if (action.dataset.action === 'edit') {
    if (document.body.classList.contains('busy')) { toast('Wait for OASIS to finish, or stop it first.'); return; }
    $('input').value = text;
    autosize();
    $('input').focus();
    $('input').setSelectionRange(text.length, text.length);
  }
}

// Follow mode, as in Codex, Cline and Goose: the view stays pinned to the
// newest output until the user scrolls up (wheel, keys, touch or the
// scrollbar), and pins again when they come back to the bottom or press
// "Jump to latest". Pinning is instant, never smooth (smooth scrolls that
// overlap while text streams are what made the view shake), and a
// ResizeObserver re-pins whenever content grows, so no event has to.
const follow = (() => {
  let following = true;
  let pinned = 0;          // scrollTop we last set, to tell our scrolls from the user's
  let frame = 0;
  const chat = () => $('chat');
  const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
  const showPill = () => {
    const el = chat();
    const pill = $('jumpLatest');
    const away = !following && el.scrollHeight - el.scrollTop - el.clientHeight > 80;
    if (pill.hidden === !away) return;
    pill.hidden = !away;
    $('jumpLatestText').textContent = document.body.classList.contains('busy') ? 'New activity below' : 'Jump to latest';
  };
  const apply = () => {
    frame = 0;
    const el = chat();
    if (following) { el.scrollTop = el.scrollHeight; pinned = el.scrollTop; }
    showPill();
  };
  const pin = () => { if (following && !frame) frame = requestAnimationFrame(apply); else if (!following) showPill(); };
  const release = () => { if (following) { following = false; showPill(); } };
  const jump = () => { following = true; if (frame) { cancelAnimationFrame(frame); frame = 0; } apply(); };
  return {
    pin, jump, release,
    get following() { return following; },
    // Toggling a step or group the user is not at the bottom of keeps it
    // under the pointer instead of pulling the view down.
    keepInPlace(node) { if (!node || !node.isConnected) return; if (node.closest('#transcript > :last-child') === null) release(); },
    init() {
      const el = chat();
      el.addEventListener('wheel', (event) => { if (event.deltaY < 0) release(); }, { passive: true });
      el.addEventListener('touchmove', () => { if (!atBottom(el)) release(); }, { passive: true });
      el.addEventListener('keydown', (event) => { if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) release(); });
      el.addEventListener('scroll', () => {
        if (atBottom(el)) { if (!following) { following = true; showPill(); } return; }
        // Moved up by something other than our own pinning (the scrollbar).
        if (following && el.scrollTop < pinned - 2) release();
        else showPill();
      }, { passive: true });
      const observer = new ResizeObserver(() => pin());
      observer.observe($('transcript'));
      observer.observe(el);
      $('jumpLatest').addEventListener('click', () => { jump(); $('input').focus({ preventScroll: true }); });
    }
  };
})();
function scrollDown(force = false) {
  if (force) follow.jump(); else follow.pin();
}

// Streaming replies: finished blocks (a paragraph, a list, a code block)
// render once and stay in place; only the block still being written is
// re-rendered. Selections and copy buttons in earlier blocks survive, and
// the work per frame stays small however long the reply gets.
let renderQueued = false;
function resetStream(turn) {
  if (!turn) return;
  turn.md = { len: 0, count: 0, html: '', tail: null, source: '' };
  if (turn.body) turn.body.replaceChildren();
}
function renderStream(turn) {
  if (!turn || !turn.body) return;
  const pending = splitTextToolCall(turn.text);
  const source = pending.text;
  if (!turn.md || !source.startsWith(turn.md.source.slice(0, turn.md.len))) resetStream(turn);
  const md = turn.md;
  const { stable } = splitStableMarkdown(source.slice(md.len));
  const body = turn.body;
  if (stable) {
    // Drop the old tail, freeze the newly finished blocks, then draw the tail.
    while (body.childNodes.length > md.count) body.lastChild.remove();
    const html = renderMarkdown(stable);
    body.insertAdjacentHTML('beforeend', html);
    md.html += html;
    md.len += stable.length;
    md.count = body.childNodes.length;
    md.tail = null;
  }
  md.source = source;
  const tail = source.slice(md.len);
  const tailKey = tail + '\u0000' + pending.tool;
  if (md.tail !== tailKey) {
    while (body.childNodes.length > md.count) body.lastChild.remove();
    if (tail) body.insertAdjacentHTML('beforeend', renderPartialMarkdown(tail));
    if (pending.tool) {
      const note = document.createElement('p');
      note.className = 'pending-tool-call';
      note.append('Preparing ', Object.assign(document.createElement('code'), { textContent: pending.tool }), '…');
      body.append(note);
    }
    md.tail = tailKey;
  }
  body.hidden = !turn.text.trim();
}
// The final text of a step: keep the streamed DOM when it already shows
// exactly this text, so the end of a reply does not redraw it.
function settleStream(turn, text) {
  if (!turn || !turn.body) return;
  const md = turn.md;
  const same = md && md.source === text && !splitTextToolCall(text).tool
    && md.html + renderPartialMarkdown(text.slice(md.len)) === renderMarkdown(text);
  if (same) { turn.text = text; renderStream(turn); return; }
  turn.body.innerHTML = renderMarkdown(text);
  turn.md = { len: text.length, count: turn.body.childNodes.length, html: turn.body.innerHTML, tail: '\u0000', source: text };
}
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!currentTurn || !currentTurn.body) return;
    renderStream(currentTurn);
    follow.pin();
  });
}
// Long chats stay on the page: old messages are skipped by layout and paint
// (content-visibility in app.css). Only past 3000 items (600 on slow
// devices) are the oldest dropped from the page; the saved chat keeps
// everything. A note at the top says so and can bring them back, and once
// the person asks for everything this chat stops trimming.
let showWholeChat = false;
function trimTranscript() {
  if (showWholeChat) return;
  const transcript = $('transcript');
  const limit = LITE ? 600 : 3000;
  let note = transcript.querySelector(':scope > .trim-note');
  const count = () => transcript.childElementCount - (note ? 1 : 0);
  let removed = 0;
  while (count() > limit) {
    const first = note ? note.nextElementSibling : transcript.firstElementChild;
    if (!first) break;
    first.remove();
    removed++;
  }
  if (!removed) return;
  if (!note) {
    note = document.createElement('div');
    note.className = 'trim-note';
    note.innerHTML = '<span></span><button type="button" class="btn small ghost">Show all</button>';
    note.querySelector('button').addEventListener('click', showAllMessages);
    transcript.prepend(note);
  }
  note.firstElementChild.textContent = 'Older messages are hidden to keep this chat fast.';
}
function showAllMessages() {
  if (document.body.classList.contains('busy')) { toast('Wait for OASIS to finish, or stop it first.'); return; }
  showWholeChat = true;
  $('transcript').replaceChildren();
  renderSavedDisplay(display);
  $('chat').scrollTop = 0;
}

// Live turn state. Each model step gets a display entry; its prose becomes a
// message and its tool calls join the live execution group.
let activeGroup = null;     // the group tool calls are joining right now
let lastTaskGroup = null;   // where subagent updates go once the agent moves on
const groupOf = new WeakMap();
function clearCursor() { for (const body of document.querySelectorAll('#transcript .body.cursor')) body.classList.remove('cursor'); }
function startStep() {
  clearCursor();
  // Drop the previous step if it ended with nothing to show.
  if (currentTurn && !currentTurn.text.trim() && !currentTurn.entry.tools.length && !currentTurn.entry.subagents && !currentTurn.entry.reasoning) {
    if (currentTurn.wrap) currentTurn.wrap.remove();
    const index = display.indexOf(currentTurn.entry);
    if (index >= 0) display.splice(index, 1);
  }
  const entry = { role: 'assistant', content: '', tools: [], at: Date.now() };
  display.push(entry);
  currentTurn = { entry, text: '', wrap: null, body: null };
}
function ensureProse() {
  if (!currentTurn) startStep();
  if (currentTurn.wrap) return;
  removeThinking();
  // The agent is talking again: the work before this folds away.
  settleGroup(activeGroup);
  activeGroup = null;
  const wrap = addMessage('assistant', '', currentTurn.entry.at);
  currentTurn.wrap = wrap;
  currentTurn.body = wrap.querySelector('.body');
  currentTurn.body.classList.add('cursor');
}
function ensureGroup() {
  if (!currentTurn) startStep();
  const transcript = $('transcript');
  if (activeGroup && transcript.lastElementChild !== activeGroup.el) {
    settleGroup(activeGroup);
    activeGroup = null;
  }
  if (!activeGroup) {
    activeGroup = createGroup([], { live: true });
    groupOf.set(activeGroup.el, activeGroup);
    liveGroups.add(activeGroup);
    transcript.appendChild(activeGroup.el);
    $('welcome').hidden = true;
  }
  return activeGroup;
}
// The live "Thinking · 12s" block. It shows whenever the model is working
// and nothing else is on screen. When the provider streams a reasoning
// summary it appears inside, live; when the model starts writing or running
// a step the block settles into a collapsed "Thought for 12s" (kept with the
// step, so a reload shows it again) or, with no reasoning text, goes away.
function removeThinking() {
  for (const t of document.querySelectorAll('#transcript .thinking.live')) settleThinking(t);
}
function settleThinking(block) {
  clearInterval(block._clock);
  const text = String(block._text || '').trim();
  if (!text) { block.remove(); return; }
  const ms = Date.now() - block._started;
  if (block._entry) block._entry.reasoning = { text, ms };
  block.replaceWith(thoughtBlock(text, ms));
}
function thinkingShell(open) {
  const block = document.createElement('div');
  block.className = 'thinking';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'thinking-head';
  head.innerHTML = '<span class="thinking-orb" aria-hidden="true"></span><span class="thinking-label"></span><span class="thinking-chev" aria-hidden="true"></span>';
  const body = document.createElement('div');
  body.className = 'thinking-text';
  body.hidden = !open;
  head.setAttribute('aria-expanded', String(open));
  head.addEventListener('click', () => {
    const next = body.hidden;
    body.hidden = !next;
    head.setAttribute('aria-expanded', String(next));
    block.dataset.userToggled = '1';
  });
  block.append(head, body);
  return block;
}
function thoughtBlock(text, ms) {
  const block = thinkingShell(false);
  block.classList.add('thought');
  block.querySelector('.thinking-label').textContent = thoughtLabel(ms);
  block.querySelector('.thinking-text').innerHTML = renderMarkdown(text);
  return block;
}
function liveThinking() {
  return document.querySelector('#transcript .thinking.live');
}
function showThinking(at) {
  // Already thinking: keep the clock running instead of starting it over
  // (a new step took over, so its entry now owns the reasoning).
  const live = liveThinking();
  if (live) {
    if (currentTurn && live._entry !== currentTurn.entry) {
      if (live._entry && live._entry.reasoning) { currentTurn.entry.reasoning = live._entry.reasoning; delete live._entry.reasoning; }
      live._entry = currentTurn.entry;
    }
    return live;
  }
  const block = thinkingShell(false);
  block.classList.add('live');
  block.setAttribute('role', 'status');
  block.setAttribute('aria-label', 'Thinking');
  block.querySelector('.thinking-head').disabled = true;
  // From the server's clock when known (the model request went out then).
  const started = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.min(Date.now(), Number(at)) : Date.now();
  block._started = started;
  block._text = '';
  block._entry = currentTurn ? currentTurn.entry : null;
  const label = block.querySelector('.thinking-label');
  // Only the visible text changes; the status role is not re-announced every second.
  label.setAttribute('aria-hidden', 'true');
  label.textContent = thinkingLabel(Date.now() - started);
  block._clock = setInterval(() => {
    if (!block.isConnected) { clearInterval(block._clock); return; }
    const next = thinkingLabel(Date.now() - started);
    if (label.textContent !== next) label.textContent = next;
  }, 1000);
  $('transcript').appendChild(block);
  $('welcome').hidden = true;
  return block;
}
// A reasoning summary streaming in: it fills the live block, opened unless
// the person closed it. Rendered at most once a frame.
function addReasoning(delta, reset) {
  if (!currentTurn) startStep();
  const block = showThinking();
  block._text = (reset ? '' : block._text) + String(delta || '');
  if (block._entry) block._entry.reasoning = { text: block._text, ms: 0 };
  const head = block.querySelector('.thinking-head');
  head.disabled = false;
  const body = block.querySelector('.thinking-text');
  if (!block.dataset.userToggled && body.hidden) { body.hidden = false; head.setAttribute('aria-expanded', 'true'); }
  if (block._frame) return;
  block._frame = requestAnimationFrame(() => {
    block._frame = 0;
    body.innerHTML = renderMarkdown(block._text);
    body.scrollTop = body.scrollHeight;
    body.classList.toggle('overflow', body.scrollHeight > body.clientHeight + 2);
    follow.pin();
  });
}
// Steps created by a live tool_start on this page (see the tool_start case).
const liveStartedSteps = new WeakSet();
function findStep(id) {
  for (const group of [activeGroup, lastTaskGroup]) {
    const tool = group && group.steps.find((t) => t.id === id);
    if (tool) return { tool, group };
  }
  const row = id && document.querySelector('#transcript .tool[data-id="' + CSS.escape(id) + '"]');
  const group = row && groupOf.get(row.closest('.steps'));
  const tool = group && group.steps.find((t) => t.id === id);
  return tool ? { tool, group } : null;
}
// Ends the live turn: steps still marked running did not finish.
function endTurn(reason) {
  removeThinking();
  clearCursor();
  if (activeGroup) {
    for (const tool of activeGroup.steps) {
      if (tool.ok !== undefined) continue;
      tool.ok = false; tool.waiting = false; tool.endedAt = Date.now();
      if (reason === 'stopped') tool.outcome = 'cancelled';
      tool.content = tool.content || tool.live || (reason === 'stopped' ? 'Stopped before it finished.' : 'Did not finish.');
      delete tool.live;
      updateStepRow(activeGroup, tool);
    }
  }
  settleGroup(activeGroup);
  activeGroup = null;
  if (currentTurn && currentTurn.wrap) messageSource.set(currentTurn.wrap, currentTurn.text);
  if (currentTurn && !currentTurn.text.trim() && !currentTurn.entry.tools.length && !currentTurn.entry.subagents && !currentTurn.entry.reasoning) {
    const index = display.indexOf(currentTurn.entry);
    if (index >= 0) display.splice(index, 1);
  }
  currentTurn = null;
}

// The agent read a steering note between steps: close the step it was on
// (nothing is running then) so the work after the note reads as new work.
function breakTurn() {
  removeThinking();
  clearCursor();
  settleGroup(activeGroup);
  activeGroup = null;
  if (currentTurn && currentTurn.wrap) messageSource.set(currentTurn.wrap, currentTurn.text);
  if (currentTurn && !currentTurn.text.trim() && !currentTurn.entry.tools.length && !currentTurn.entry.subagents && !currentTurn.entry.reasoning) {
    const index = display.indexOf(currentTurn.entry);
    if (index >= 0) display.splice(index, 1);
    if (currentTurn.wrap) currentTurn.wrap.remove();
  }
  currentTurn = null;
}
function showSteer(note) {
  const at = Date.now();
  display.push({ role: 'user', content: note, at, steer: true });
  const el = addMessage('user', note, at);
  el.classList.add('steer');
  scrollDown();
}
const LIVE_KEEP = 16_000; // characters of live output kept per running step

// One clock for the whole run, started from the server's start time when
// there is one, so a reload or another device shows the same "Working 42s".
// It ticks once a second and writes only when the text changes. The header
// is run start to now, wall time, and groups measure on the same clock (see
// groupTiming), so a group can never claim more time than the header.
// An event's server time on this page's clock, or now when it has none.
function serverTime(at) {
  const value = Number(at);
  return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : Date.now();
}
const runClock = {
  startedAt: 0,
  timer: 0,
  start(at) {
    const value = Number(at);
    if (!Number.isFinite(value) || value <= 0) return;
    const fresh = !(this.startedAt && this.timer);
    // A server time only moves the start earlier (a resumed run), never later.
    this.startedAt = fresh ? value : Math.min(this.startedAt, value);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  },
  worked(now = Date.now()) {
    return runElapsed(this.startedAt, now);
  },
  tick() {
    const el = $('runStatus');
    if (!el) return;
    if (!document.body.classList.contains('busy') || !this.startedAt) { if (!el.hidden) el.hidden = true; return; }
    const waiting = !$('approvalSheet').hidden;
    const now = Date.now();
    // Nothing running, nothing streaming for a moment: show Thinking, so the
    // page never sits blank while the model works.
    if (!waiting && !agent.detached && now - lastActivity >= IDLE_THINKING_MS && !liveThinking() && !stepsRunning() && $('questionSheet').hidden) showThinking(lastActivity);
    const text = (waiting ? 'Waiting for you' : 'Working') + ' · ' + formatDuration(this.worked(now)) + ' · Esc to stop';
    const label = el.querySelector('.run-status-text');
    if (label.textContent !== text) label.textContent = text;
    el.classList.toggle('waiting', waiting);
    if (el.hidden) el.hidden = false;
  },
  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    const ms = this.worked();
    this.startedAt = 0;
    const el = $('runStatus');
    if (el) el.hidden = true;
    return ms;
  }
};
// The end of a run: one quiet line says how long it took, and notes the
// agent never got to read are shown (the computer keeps them for the next
// message).
// Where the model's time went in this run, one record per request (time to
// first token, total, tokens). Hover the "Worked for" line to see it.
let runTimings = [];
function timingSummary(records = []) {
  if (!records.length) return '';
  const sec = (ms) => (Number(ms) >= 0 ? (ms / 1000).toFixed(1) + 's' : '–');
  return records.map((r) => 'Model call ' + r.step + ': first token ' + sec(r.ttftMs) + ', total ' + sec(r.totalMs) + ', silent tail ' + sec(r.silentTailMs) + ', ' + (r.inputTokens || r.inputEstimate || 0) + ' in / ' + (r.outputTokens || 0) + ' out' + (r.toolCalls ? ', ' + r.toolCalls + ' tool call' + (r.toolCalls === 1 ? '' : 's') : '')).join('\n');
}
function finishRun(prefix) {
  const ms = runClock.stop();
  const timings = runTimings;
  runTimings = [];
  for (const note of pendingInputs.take('steer')) showSteer(note);
  if (prefix && ms >= 1000) {
    const content = prefix + ' ' + formatDuration(ms);
    display.push({ role: 'worked', content, ...(timings.length ? { timings } : {}) });
    const line = addMessage('worked', content);
    if (timings.length) line.title = timingSummary(timings);
  }
}

// Messages typed while OASIS works, shown as chips above the message box:
// a note (read at the next step), a queued message (sent when the run
// ends) or an interrupt (sent once the run has stopped).
const pendingInputs = {
  items: [],
  seq: 0,
  add(kind, content) {
    this.items.push({ id: ++this.seq, kind, content });
    this.render();
  },
  take(kind, count = Infinity) {
    const taken = [];
    this.items = this.items.filter((item) => {
      if (item.kind !== kind || taken.length >= count) return true;
      taken.push(item.content);
      return false;
    });
    this.render();
    return taken;
  },
  remove(id) {
    this.items = this.items.filter((item) => item.id !== id);
    this.render();
  },
  render() {
    const box = $('pendingInputs');
    if (!box) return;
    const LABELS = { steer: 'Read at the next step', queued: 'Sends when this finishes', interrupt: 'Sends once stopped' };
    box.replaceChildren(...this.items.map((item) => {
      const chip = document.createElement('div');
      chip.className = 'pending-input ' + item.kind;
      chip.setAttribute('role', 'listitem');
      const kind = document.createElement('span');
      kind.className = 'pending-kind';
      kind.textContent = LABELS[item.kind];
      const text = document.createElement('span');
      text.className = 'pending-text';
      text.textContent = item.content.length > 140 ? item.content.slice(0, 139) + '…' : item.content;
      text.title = item.content;
      chip.append(kind, text);
      if (item.kind !== 'steer') {
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'pending-drop';
        drop.setAttribute('aria-label', 'Remove this queued message');
        drop.textContent = '×';
        drop.addEventListener('click', () => {
          this.remove(item.id);
          if (!$('input').value.trim()) { $('input').value = item.content; autosize(); updateSteering(); }
          $('input').focus();
        });
        chip.appendChild(drop);
      }
      return chip;
    }));
    box.hidden = !this.items.length;
  },
  // After a run: send an interrupt first, else the oldest queued message.
  next() {
    const pick = this.items.find((item) => item.kind === 'interrupt') || this.items.find((item) => item.kind === 'queued');
    if (!pick) return null;
    this.remove(pick.id);
    return pick.content;
  }
};
function flushPendingInputs() {
  if (agent.busy || agent.detached) return;
  const next = pendingInputs.next();
  if (next) void send(next);
}

// When the page last showed something new from the run (text, a step, output).
let lastActivity = Date.now();
const IDLE_THINKING_MS = 1000;
const QUIET_EVENTS = new Set(['usage', 'context', 'cost', 'model_end', 'run_clock', 'todos', 'model_timing']);
function stepsRunning() {
  return Boolean(activeGroup && activeGroup.live && activeGroup.steps.some((step) => step.ok === undefined));
}
function handleEvent(event) {
  handleRunEvent(event);
  if (event.type !== 'text' && event.type !== 'reasoning') refreshActivity();
}
function handleRunEvent(event) {
  if (!QUIET_EVENTS.has(event.type)) lastActivity = Date.now();
  switch (event.type) {
    case 'user': {
      // Older runtimes sent a steering note as a 'user' event; it is not a new turn.
      if (event.steer) { handleEvent({ type: 'steer', content: event.content }); break; }
      endTurn('');
      lastTaskGroup = null;
      runClock.start(Date.now());
      // The Undo button already dimmed the turn; a "/undo" bubble repeats it.
      if (quietUndo && event.content === '/undo') { quietUndo = false; break; }
      const at = Date.now();
      display.push({ role: 'user', content: event.content, at, ...(event.images ? { images: event.images } : {}) });
      const el = addMessage('user', event.content, at);
      if (event.images) addImageNote(el, event.images, sentThumbs);
      sentThumbs = [];
      scrollDown(true);
      break;
    }
    case 'thinking':
      startStep();
      showThinking();
      scrollDown();
      break;
    case 'reasoning':
      addReasoning(event.delta, event.reset);
      break;
    case 'model_start':
      // The model is working and nothing runs or streams: say so at once.
      if (!stepsRunning()) { showThinking(event.startedAt); scrollDown(); }
      break;
    case 'model_end': break;
    case 'delta':
      if (!currentTurn) startStep();
      ensureProse();
      currentTurn.text += event.delta;
      queueRender();
      removeThinking();
      break;
    case 'retry':
      // A retried request starts its reply over; drop any half-streamed text.
      if (currentTurn) { currentTurn.text = ''; resetStream(currentTurn); }
      toast(event.waitMs ? 'Rate limited for a moment; retrying in ' + Math.ceil(event.waitMs / 1000) + 's…' : 'Provider busy, retrying (' + event.attempt + ')…');
      break;
    case 'truncated':
      toast(event.tool ? 'The reply hit the output limit while writing ' + event.tool + '; asking the model to split it.' : 'The reply hit the output limit; asking the model to continue.');
      break;
    case 'model_switch': {
      const kind = classifyFailure({ message: event.reason, status: Number((String(event.reason).match(/\((\d{3})\)/) || [])[1] || 0) });
      if (currentTurn) { currentTurn.text = ''; resetStream(currentTurn); }
      const line = event.from + ' ' + (SWITCH_REASONS[kind] || 'failed') + '. Switched to ' + event.to + ' and carried on.';
      display.push({ role: 'note', content: line });
      addMessage('note', line);
      break;
    }
    case 'assistant': {
      if (!currentTurn) startStep();
      let text = event.content || '';
      // The same summary twice in one turn (an echo after a verification nudge) shows once.
      if (text.trim() && !(event.toolCalls && event.toolCalls.length) && repeatsEarlierReply(display, currentTurn.entry, text)) text = '';
      currentTurn.text = text;
      currentTurn.entry.content = text;
      if (text.trim()) {
        ensureProse();
        removeThinking();
        messageSource.set(currentTurn.wrap, text);
        settleStream(currentTurn, text);
        currentTurn.body.hidden = false;
        if (!(event.toolCalls && event.toolCalls.length)) currentTurn.body.classList.add('cursor');
        else currentTurn.body.classList.remove('cursor');
      } else if (currentTurn.wrap) { currentTurn.wrap.remove(); currentTurn.wrap = null; currentTurn.body = null; }
      if (!text.trim() && !(event.toolCalls && event.toolCalls.length)) removeThinking();
      break;
    }
    case 'tool_start': {
      // Reattaching replays the live task's events. A step of this turn that
      // is already on the page from a copy saved mid-turn is updated in place
      // instead of being shown twice. Steps started live here are never
      // merged (models may reuse call ids), nor are steps of earlier turns.
      const seen = event.id && findStep(event.id);
      const lastRequest = [...document.querySelectorAll('#transcript .msg.user')].pop();
      const seenRow = seen && document.querySelector('#transcript .tool[data-id="' + CSS.escape(event.id) + '"]');
      if (seen && seenRow && !liveStartedSteps.has(seen.tool) && lastRequest && (lastRequest.compareDocumentPosition(seenRow) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        if (event.label) seen.tool.label = event.label;
        if (event.args) seen.tool.args = event.args;
        updateStepRow(seen.group, seen.tool);
        break;
      }
      if (!currentTurn) startStep();
      removeThinking();
      clearCursor();
      const group = ensureGroup();
      const tool = { id: event.id, name: event.name, args: event.args || {}, startedAt: serverTime(event.at), ...(event.label ? { label: event.label } : {}), ...(event.open ? { open: true } : {}) };
      liveStartedSteps.add(tool);
      currentTurn.entry.tools.push(tool);
      group.steps.push(tool);
      if (event.name === 'task') { lastTaskGroup = group; lastTaskGroup.taskEntry = currentTurn.entry; }
      updateStepRow(group, tool);
      scrollDown();
      break;
    }
    case 'tool_result': {
      let found = findStep(event.id);
      if (!found) {
        // A result without a start (an older runtime): show it as a finished step.
        if (!currentTurn) startStep();
        const group = ensureGroup();
        const tool = { id: event.id || 'step_' + Date.now(), name: event.name, args: {}, startedAt: Date.now() };
        currentTurn.entry.tools.push(tool);
        group.steps.push(tool);
        found = { tool, group };
      }
      const { tool, group } = found;
      tool.ok = event.ok;
      if (event.outcome) tool.outcome = event.outcome;
      if (event.more) tool.more = true;
      delete tool.live;
      setWaiting(tool, false);
      tool.endedAt = Math.max(Number(tool.startedAt) || 0, serverTime(event.at));
      if (Number.isFinite(Number(event.durationMs))) tool.durationMs = Number(event.durationMs);
      if (event.label) tool.label = event.label;
      if (event.ok !== false && /write|edit|patch|delete|move|rename|notebook/i.test(String(event.name || tool.name || ''))) turnEdited = true;
      if (event.ok !== false && /^(write_file|edit_file|multi_edit)$/.test(String(event.name || tool.name || '')) && /\.html?$/i.test(String((tool.args && tool.args.path) || ''))) turnPage = String(tool.args.path).replace(/^\.\//, '');
      if (RT && /^(write_file|edit_file|multi_edit|delete_file|notebook_edit|run_command|git_commit)$/.test(event.name || tool.name)) refreshFiles();
      const content = String(event.content || '');
      if (content.length > 6000) tool.more = true;
      tool.content = content.length > 6000 ? content.slice(0, 6000) + '\n…' : content;
      updateStepRow(group, tool);
      if (stepState(tool) === 'fail') sound('fail');
      break;
    }
    case 'tool_output': {
      // Live output of a running command: the last lines show under its row.
      const found = findStep(event.id);
      if (!found || found.tool.ok !== undefined) break;
      const tool = found.tool;
      const next = (tool.live || '') + event.text;
      tool.live = next.length > LIVE_KEEP ? next.slice(next.length - LIVE_KEEP) : next;
      const row = found.group.list.querySelector('[data-id="' + CSS.escape(tool.id) + '"]');
      if (row) patchStepRow(row, tool);
      follow.pin();
      break;
    }
    case 'steer':
      pendingInputs.add('steer', event.content);
      break;
    case 'steered':
      // The agent read these notes: they join the transcript where it read them.
      breakTurn();
      for (const note of pendingInputs.take('steer', event.delivered || 1)) showSteer(note);
      break;
    case 'run_clock':
      runClock.start(event.startedAt);
      break;
    case 'model_timing':
      if (runTimings.length < 200) runTimings.push(event);
      break;
    case 'approval_waiting':
      markWaitingTools(true);
      break;
    case 'approval_answered':
      markWaitingTools(false);
      break;
    case 'subagents': {
      const group = lastTaskGroup || ensureGroup();
      const owner = group.taskEntry || (currentTurn && currentTurn.entry);
      if (owner) owner.subagents = event.workers;
      renderSubagents(group, event.workers);
      break;
    }
    case 'todos': renderTodos(event.todos); break;
    case 'usage': usageState.tokens = event.usage.input + event.usage.output; renderUsage(); break;
    case 'context': usageState.context = event; renderUsage(); break;
    case 'cost': usageState.cost = event; renderUsage(); break;
    case 'mcp_failures': {
      // Servers that only need sign-in get a Connect card instead of advice to run a command.
      const signIn = event.servers.filter((server) => server.signInUrl);
      const rest = event.servers.filter((server) => !server.signInUrl);
      if (rest.length) addMessage('note', (rest.length === 1 ? 'A tool server did not start. ' : rest.length + ' tool servers did not start. ') + rest.map((server) => server.name + ': ' + String(server.error).replace(/^MCP server \S+ (?:could not start: )?/, '')).join(' · '));
      for (const server of signIn.slice(0, 3)) connectShortcut('/connect ' + server.signInUrl, { reason: server.name + ' needs you to sign in before its tools can be used.' });
      break;
    }
    case 'notices': for (const note of event.notices || []) addMessage('note', note); break;
    case 'compacting': showThinking(); break;
    case 'compacted': addMessage('note', event.mode === 'summary' ? 'Earlier conversation summarised to save context.' : event.mode === 'digest' ? 'Earlier conversation condensed to a short digest (the model could not summarise it).' : 'Older tool output trimmed to save context.'); break;
    case 'compaction_error': toast('Could not summarise the earlier conversation: ' + event.message); break;
    case 'context_overflow': toast('The conversation was too long for the model; condensed it and asked again.'); break;
    case 'empty_reply': toast('The model sent an empty reply; asking again.'); break;
    case 'stopped':
      endTurn('stopped');
      finishRun('Stopped after');
      addMessage('note', 'Stopped.');
      break;
    case 'error': {
      endTurn('error');
      finishRun('');
      display.push({ role: 'error', content: event.message });
      const card = addMessage('error', event.message);
      if (event.activeJob) busyFolderActions(card, event.activeJob, event.request || '');
      else offerRetry(card);
      sound('fail');
      scrollDown(true);
      break;
    }
    case 'job':
      // The task now runs on the computer: save where its output starts, so
      // a reload (or another device) can rebuild the turn and keep following it.
      { let last = display.length - 1; while (last >= 0 && display[last].role !== 'user') last--; turnStart = last + 1; }
      persistChat();
      break;
    case 'resumed':
      toast('Reconnected to the task that was running.');
      break;
    case 'reconnecting':
      toast('Connection lost. Reconnecting… The task keeps running on the computer.');
      break;
    case 'reconnected':
      toast('Back online.');
      break;
    case 'answered_elsewhere':
      // Another browser or the terminal answered first (or the task ended).
      if (event.kind === 'connector') { for (const ui of liveConnectorCards.values()) ui.stop(); liveConnectorCards.clear(); toast('The connect card was answered somewhere else.'); break; }
      if (event.kind === 'question') closeSheet('questionSheet'); else closeSheet('approvalSheet');
      toast(event.kind === 'question' ? 'The question was answered somewhere else.' : 'This was answered on another device.');
      break;
    case 'detached':
      // Switched to another chat: the task keeps running on the computer and
      // this chat reattaches when it is opened again. Nothing is saved here,
      // so the saved job id survives.
      removeThinking();
      clearCursor();
      break;
    case 'done':
      endTurn('');
      finishRun('Worked for');
      offerUndo();
      trimTranscript();
      sound('done');
      break;
    default: break;
  }
}

// Saved chats render through the same grouping as the live view.
function renderSavedDisplay(entries) {
  refreshActivity();
  const blocks = buildTimeline(entries);
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'group') {
      const group = createGroup(block.steps, { live: false });
      if (verboseSteps()) setGroupOpen(group, true);
      groupOf.set(group.el, group);
      $('transcript').appendChild(group.el);
      if (block.subagents.length) renderSubagents(group, block.subagents);
      continue;
    }
    const entry = block.entry;
    if (block.type === 'reasoning') {
      $('transcript').appendChild(thoughtBlock(String(entry.reasoning.text), Number(entry.reasoning.ms)));
      continue;
    }
    // A tool call the model wrote as JSON text ran as the steps that follow, so show
    // only the prose before it (chats saved before the live view dropped it).
    let content = entry.content;
    if (block.type === 'text' && blocks[index + 1] && blocks[index + 1].type === 'group') {
      const split = splitTextToolCall(content);
      if (split.tool) { if (!split.text.trim()) continue; content = split.text; }
    }
    const el = addMessage(block.type === 'text' ? 'assistant' : entry.role, content, Number(entry.at) || 0);
    if (entry.role === 'user' && entry.images) addImageNote(el, entry.images, []);
    if (entry.role === 'user' && entry.steer) el.classList.add('steer');
    if (entry.role === 'worked' && Array.isArray(entry.timings)) el.title = timingSummary(entry.timings);
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
    // The whole chat is kept: cutting it to the last few hundred entries lost
    // the start of long chats on reload and could orphan tool results.
    display: display.map((entry) => ({ ...entry, tools: entry.tools && entry.tools.map((t) => ({ ...t, content: (t.content || '').slice(0, 2000) })) })),
    ...(RT && agent.busy && agent.jobId ? { turnStart } : {}),
    messages: RT ? agent.snapshot() : agent.messages.map((m) => (Array.isArray(m.content) ? { ...m, content: textOf(m.content) + ' (image not kept in saved chats)' } : m)),
    ...(!RT ? { pendingSteering: agent.steering.slice(0, 20) } : {})
  }; } catch { return chatSaving; }
  const save = () => saveChat(snapshot);
  chatSaving = chatSaving.then(save, save);
  chatSaving.then(() => renderSidebar()).catch(() => {});
  return chatSaving;
}
async function saveChat(snapshot) {
  const { projectId, id, display: trimmed } = snapshot;
  try {
    const record = {
      messages: snapshot.messages,
      ...(Number.isInteger(snapshot.turnStart) ? { turnStart: snapshot.turnStart } : {}),
      ...(snapshot.pendingSteering ? { pendingSteering: snapshot.pendingSteering } : {}),
      display: trimmed
    };
    try { await store.setValue(chatKey(projectId, id), record); }
    catch (error) {
      // Storage full: keep the recent part rather than nothing.
      if (!Array.isArray(record.messages) || record.messages.length <= 300) throw error;
      const cut = record.display.length - 200;
      await store.setValue(chatKey(projectId, id), { ...record, messages: answeredHistory(record.messages.slice(-300)), display: record.display.slice(-200), ...(Number.isInteger(record.turnStart) ? { turnStart: Math.max(0, record.turnStart - Math.max(0, cut)) } : {}) });
    }
    const index = await chatIndex(projectId);
    // The chat open right now stays current, even if this save is for one the user just left.
    index.current = workspace && workspace.project.id === projectId ? chatId : index.current || id;
    index.list = index.list.filter((item) => item.id !== id);
    if (trimmed.length) index.list.unshift({ id, title: snapshot.title, updatedAt: Date.now() });
    await store.setValue('chats:' + projectId, index);
  } catch { /* storage full: chat stays in memory */ }
}

async function newChat() {
  if (!(await leaveTurn()) && workspace) await persistChat();
  chatId = Math.random().toString(36).slice(2, 10);
  if (workspace) { const index = await chatIndex(workspace.project.id); index.current = chatId; await store.setValue('chats:' + workspace.project.id, index); }
  await restoreChat({ keepChat: true });
  renderWelcome();
  $('input').focus();
}

async function openChat(id) {
  if (!workspace || id === chatId) return;
  if (!(await leaveTurn())) await persistChat();
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
    del.innerHTML = icon('trash-2');
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
  void renderRuntimeSessions();
  void renderRunMonitor();
}
// Recent agent runs on the computer (from any chat, browser or the
// terminal): what state each is in, its workers and open approvals. Only
// lifecycle facts come back from the server, never prompts or output.
const RUN_STATES = { queued: 'Queued', running: 'Working', waiting_approval: 'Waiting for you', completed: 'Done', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' };
async function renderRunMonitor() {
  const list = $('runMonitorList');
  const label = $('runMonitorLabel');
  if (!RT || RT.needsToken) { list.hidden = label.hidden = true; return; }
  let runs = [];
  try { runs = (await RT.client.api('/api/agent-monitor')).runs || []; } catch { list.hidden = label.hidden = true; return; }
  runs = runs.slice(0, 12);
  list.hidden = label.hidden = !runs.length;
  list.replaceChildren(...runs.map((run) => {
    const li = document.createElement('li');
    const live = LIVE_JOB.has(run.status);
    li.className = 'run-item ' + String(run.status || '').replace(/[^a-z_]/g, '');
    const title = document.createElement('strong');
    title.textContent = run.title || 'Coding task';
    const meta = document.createElement('span');
    meta.className = 'run-meta';
    const parts = [RUN_STATES[run.status] || run.status];
    if (run.runningWorkers) parts.push(run.runningWorkers + ' of ' + run.workerCount + ' workers running');
    else if (run.workerCount) parts.push(run.workerCount + (run.workerCount === 1 ? ' worker' : ' workers'));
    if (run.approvals && run.approvals.pending) parts.push(run.approvals.pending + ' approval' + (run.approvals.pending === 1 ? '' : 's') + ' open');
    if (run.branch) parts.push(run.branch);
    const when = Date.parse(run.updatedAt || run.createdAt || '');
    if (Number.isFinite(when)) parts.push(live ? 'started ' + elapsedSince(Date.parse(run.createdAt || run.updatedAt)) + ' ago' : new Date(when).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
    meta.textContent = parts.filter(Boolean).join(' · ');
    const text = document.createElement('div');
    text.className = 'run-text';
    text.append(title, meta);
    if (run.error) { const err = document.createElement('span'); err.className = 'run-error'; err.textContent = run.error; text.appendChild(err); }
    const dot = document.createElement('span');
    dot.className = 'run-dot';
    dot.setAttribute('aria-hidden', 'true');
    li.append(dot, text);
    if (live && run.id !== agent.jobId) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn small ghost';
      stop.textContent = 'Stop';
      stop.setAttribute('aria-label', 'Stop ' + (run.title || 'this run'));
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        try { await RT.client.api('/api/jobs/' + run.id + '/cancel', { method: 'POST', body: {} }); toast('Stopping that run. Finished work stays.'); }
        catch { toast('Could not stop that run.'); }
        void renderRunMonitor();
      });
      li.appendChild(stop);
    }
    return li;
  }));
}
// Sessions saved by OASIS on this computer (terminal runs included) that this
// browser has no chat for yet. Opening one continues it with its history.
// The server's session store is shared by every browser and the terminal;
// this browser's chat list only knows the chats it started or opened.
async function runtimeSessionState() {
  if (!mcpAvailable() || !workspace) return null;
  let sessions = [];
  try { sessions = (await RT.client.api('/api/sessions')).sessions || []; } catch { return null; }
  const linked = new Set([agent.sessionId].filter(Boolean));
  const chatSessions = new Map();
  const index = await chatIndex(workspace.project.id);
  for (const item of index.list) {
    const saved = await store.getValue(chatKey(workspace.project.id, item.id)).catch(() => null);
    if (saved && saved.messages && typeof saved.messages.sessionId === 'string' && saved.messages.sessionId) { linked.add(saved.messages.sessionId); chatSessions.set(item.id, saved.messages.sessionId); }
  }
  const running = new Set(sessions.filter((item) => item && item.running).map((item) => item.id));
  const waiting = new Set(sessions.filter((item) => item && item.running && item.waiting).map((item) => item.id));
  return { sessions, linked, running, waiting, chatSessions };
}
async function unlinkedRuntimeSessions(limit = 12, state = null) {
  const known = state || await runtimeSessionState();
  if (!known) return null;
  return known.sessions.filter((item) => item && item.id && !known.linked.has(item.id) && (item.messages > 0 || item.running)).slice(0, limit);
}
async function renderRuntimeSessions() {
  const list = $('runtimeSessionList');
  const show = (on) => { for (const id of ['runtimeSessionsLabel', 'runtimeSessionsHint', 'runtimeSessionList']) $(id).hidden = !on; };
  const items = await unlinkedRuntimeSessions();
  if (!items) { show(false); return; }
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'project-item';
    const open = document.createElement('button');
    open.className = 'open';
    open.innerHTML = '<strong></strong><span></span>';
    open.querySelector('strong').textContent = item.title || 'Untitled session';
    const when = item.updatedAt ? new Date(item.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    open.querySelector('span').textContent = [item.running ? 'Running now' : when, item.model].filter(Boolean).join(' · ');
    open.addEventListener('click', async () => { closeSheet('chatsSheet'); await openRuntimeSession(item); });
    li.append(open);
    // Archiving is shared: the terminal, editors and other browsers stop
    // offering it too. `oasis sessions unarchive ID` brings it back.
    if (!item.running && !item.unsaved) {
      const archive = document.createElement('button');
      archive.className = 'icon-btn small';
      archive.setAttribute('aria-label', 'Archive session ' + (item.title || ''));
      archive.title = 'Archive';
      archive.innerHTML = icon('archive');
      archive.addEventListener('click', async () => {
        try { await RT.client.api('/api/sessions/' + encodeURIComponent(item.id) + '/archive', { method: 'POST' }); }
        catch (error) { toast('Could not archive that session: ' + error.message, 'error'); return; }
        toast('Archived. Run oasis sessions unarchive ' + item.id + ' to bring it back.');
        void renderRuntimeSessions();
      });
      li.append(archive);
    }
    list.appendChild(li);
  }
  show(items.length > 0);
}
async function openRuntimeSession(item) {
  let saved;
  try { saved = item.unsaved && item.jobId ? { messages: [] } : await RT.client.api('/api/sessions/' + item.id); }
  catch (error) {
    // A conversation whose first turn is still running is not saved yet:
    // follow the live task with just its request.
    if (!(error.status === 404 && item.jobId)) { toast('Could not open that session: ' + error.message, 'error'); return; }
    saved = { messages: [] };
  }
  if (!(await leaveTurn())) await persistChat();
  chatId = Math.random().toString(36).slice(2, 10);
  const projectId = workspace.project.id;
  // Newer servers send the timeline with its steps; older ones only the text.
  const shown = Array.isArray(saved.display) && saved.display.length
    ? saved.display.map((entry) => ({ ...entry, at: 0 }))
    : (saved.messages || []).map((entry) => ({ role: entry.role, content: entry.content, at: 0 }));
  // Still running (started in another browser or the terminal): show the
  // request it is working on, then attach to the live task.
  const live = typeof item.jobId === 'string' && item.jobId;
  // The live turn is replayed from the task's events, so a copy saved to disk
  // mid-turn is dropped here (otherwise its steps show twice); the request it
  // is working on always shows.
  const prompt = live ? String(item.prompt || item.title || '') : '';
  if (live) {
    let mine = shown.length - 1;
    while (mine >= 0 && !(shown[mine].role === 'user' && shown[mine].content === prompt)) mine--;
    if (mine >= 0) shown.splice(mine + 1);
    else if (!shown.some((entry) => entry.role === 'user')) shown.length = 0;
  }
  if (live && prompt && !(shown.length && shown[shown.length - 1].role === 'user' && shown[shown.length - 1].content === prompt)) shown.push({ role: 'user', content: prompt, at: Date.now() });
  await store.setValue(chatKey(projectId, chatId), { messages: { sessionId: item.id, pendingShell: [], ...(live ? { jobId: item.jobId } : {}) }, display: shown, ...(live ? { turnStart: shown.length } : {}) });
  const index = await chatIndex(projectId);
  index.current = chatId;
  index.list = [{ id: chatId, title: item.title || 'Session', updatedAt: Date.now() }, ...index.list];
  await store.setValue('chats:' + projectId, index);
  await restoreChat({ keepChat: true });
  refreshFiles();
  toast(live ? 'Following the task that is running on this computer.' : 'Continuing this session. New messages keep its history.');
}
// Another task holds this folder (409 from /api/chat): offer to open it, or
// stop it and send the request that was turned away.
const LIVE_JOB = new Set(['queued', 'running', 'waiting_approval']);
function busyFolderActions(card, job, request) {
  const row = document.createElement('div');
  row.className = 'msg-actions-row';
  const open = document.createElement('button');
  open.type = 'button'; open.className = 'chip'; open.textContent = 'Open the running task';
  const stop = document.createElement('button');
  stop.type = 'button'; stop.className = 'chip'; stop.textContent = request ? 'Stop it and send this' : 'Stop it';
  open.addEventListener('click', () => void openActiveJob(job));
  stop.addEventListener('click', async () => {
    open.disabled = stop.disabled = true;
    stop.textContent = 'Stopping…';
    if (!(await stopActiveJob(job))) { toast('That task did not stop. Open it and stop it from there.', 'error'); open.disabled = stop.disabled = false; stop.textContent = request ? 'Stop it and send this' : 'Stop it'; return; }
    // Drop the turned-away request and this note, then send the request again.
    let last = display.length - 1; while (last >= 0 && display[last].role !== 'user') last--;
    if (last >= 0) display.splice(last);
    const shown = card.previousElementSibling;
    if (shown && shown.classList.contains('user')) shown.remove();
    card.remove();
    await persistChat();
    if (request) await send(request);
    else toast('Stopped. This folder is free again.');
  });
  row.append(open, stop);
  card.appendChild(row);
}
async function stopActiveJob(job) {
  try { await RT.client.api('/api/jobs/' + job.id + '/cancel', { method: 'POST', body: {} }); }
  catch (error) { if (error.status !== 404 && error.status !== 409) return false; }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const state = await RT.client.api('/api/jobs/' + job.id); if (!LIVE_JOB.has(state.status)) return true; }
    catch (error) { if (error.status === 404) return true; }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}
async function openActiveJob(job) {
  const state = await runtimeSessionState();
  if (state && job.sessionId) {
    for (const [id, sessionId] of state.chatSessions) if (sessionId === job.sessionId) { await openChat(id); return; }
    const listed = state.sessions.find((item) => item && item.id === job.sessionId);
    if (listed) { await openRuntimeSession({ ...listed, jobId: listed.jobId || job.id, prompt: listed.prompt || job.prompt || job.title || '' }); return; }
  }
  await openRuntimeSession({ id: job.sessionId || job.id, title: job.title, prompt: job.prompt || job.title, jobId: job.id, running: true, unsaved: true });
}
/* ---------- Sidebar: tasks at a glance (wide screens) ---------- */
// Like the session lists in Codex, Claude Code and Devin: one click to start
// or switch a task, and a live dot on the one that is working or waiting.
// It renders the same chat index as the Chats sheet, which stays the way in
// on narrow screens.
function relativeTime(ms) {
  if (!ms) return '';
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return minutes + 'm';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h';
  const days = Math.round(hours / 24);
  return days < 7 ? days + 'd' : new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
let sidebarRender = 0;
async function renderSidebar() {
  const list = $('sideTasks');
  if (!list || getComputedStyle($('sidebar')).display === 'none') return;
  const ticket = ++sidebarRender;
  const index = workspace ? await chatIndex(workspace.project.id).catch(() => ({ list: [] })) : { list: [] };
  if (ticket !== sidebarRender) return;
  const items = index.list.slice(0, 40);
  const busy = document.body.classList.contains('busy');
  const waiting = !$('approvalSheet').hidden;
  if (!items.some((item) => item.id === chatId) && display.some((entry) => entry.role === 'user')) items.unshift({ id: chatId, title: chatTitle(), updatedAt: Date.now() });
  $('sideTasksLabel').textContent = workspace ? (workspace.project.name || 'Tasks') : 'Tasks';
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'side-empty';
    li.textContent = workspace ? 'Your tasks appear here.' : 'Connect to start a task.';
    list.appendChild(li);
  }
  for (const item of items) {
    const current = item.id === chatId;
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'side-task' + (current ? ' current' : '') + (current && busy ? (waiting ? ' waiting' : ' running') : '');
    open.dataset.chat = item.id;
    if (current) open.setAttribute('aria-current', 'page');
    open.innerHTML = '<span class="side-dot" aria-hidden="true"></span><span class="side-title"></span><span class="side-when"></span>';
    open.querySelector('.side-title').textContent = item.title || 'New chat';
    open.querySelector('.side-when').textContent = current && busy ? (waiting ? 'Needs you' : 'Working') : relativeTime(item.updatedAt);
    open.title = item.title || 'New chat';
    open.addEventListener('click', () => { if (!current) void openChat(item.id).then(renderSidebar); });
    li.appendChild(open);
    list.appendChild(li);
  }
  void renderSideSessions(ticket);
  const host = location.host;
  $('sideStatusText').textContent = RT && !RT.needsToken ? (location.protocol === 'https:' ? 'Secure · ' : '') + host : RT ? 'Waiting for access key' : 'This browser only';
  $('sideStatus').classList.toggle('ok', Boolean(RT && !RT.needsToken));
}
// Conversations on this computer that this browser has not opened: started
// in the terminal or on another device. A running one attaches when opened.
async function renderSideSessions(ticket) {
  const state = await runtimeSessionState();
  const items = state ? await unlinkedRuntimeSessions(8, state) : null;
  if (ticket !== sidebarRender) return;
  // Chats left while their task kept running on the computer: working,
  // waiting for an answer, or finished and not looked at yet (like the
  // unread markers in Codex's and Claude Code's task lists).
  if (state) {
    const unread = unreadChats();
    let changed = false;
    for (const button of $('sideTasks').querySelectorAll('.side-task[data-chat]')) {
      const id = button.dataset.chat;
      if (id === chatId) { if (unread.delete(id)) changed = true; backgroundRunning.delete(id); continue; }
      const session = state.chatSessions.get(id);
      if (state.running.has(session)) {
        backgroundRunning.add(id);
        const waiting = state.waiting.has(session);
        button.classList.add('running');
        button.classList.toggle('waiting', waiting);
        button.querySelector('.side-when').textContent = waiting ? 'Needs you' : 'Working';
        button.title = (button.title || 'Task') + (waiting ? ' (waiting for your answer)' : ' (running now)');
        continue;
      }
      if (backgroundRunning.delete(id)) { unread.add(id); changed = true; }
      if (unread.has(id)) {
        button.classList.add('unread');
        button.querySelector('.side-when').textContent = 'Done';
        button.title = (button.title || 'Task') + ' (finished, not opened yet)';
      }
    }
    if (changed) saveUnreadChats(unread);
  }
  const list = $('sideSessions');
  $('sideSessionsLabel').hidden = list.hidden = !(items && items.length);
  list.replaceChildren();
  for (const item of items || []) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'side-task' + (item.running ? ' running' : '');
    open.innerHTML = '<span class="side-dot" aria-hidden="true"></span><span class="side-title"></span><span class="side-when"></span>';
    open.querySelector('.side-title').textContent = item.title || 'Untitled session';
    open.querySelector('.side-when').textContent = item.running ? 'Working' : relativeTime(Date.parse(item.updatedAt) || 0);
    open.title = (item.title || 'Untitled session') + (item.running ? ' (running now)' : '');
    open.addEventListener('click', () => void openRuntimeSession(item));
    li.appendChild(open);
    list.appendChild(li);
  }
}
// Chats whose background task finished since they were last open.
const backgroundRunning = new Set();
const UNREAD_KEY = 'oasis.unreadChats';
function unreadChats() {
  try { const list = JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]'); return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, 100) : []); }
  catch { return new Set(); }
}
function saveUnreadChats(set) {
  try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...set].slice(0, 100))); } catch { /* storage blocked */ }
}
// A task left running in another chat finishes on its own; refresh its dot.
setInterval(() => {
  if (document.visibilityState === 'visible' && document.querySelector('#sidebar .side-task.running:not(.current)')) void renderSidebar();
}, 8000);
// Coming back to the tab shows what finished meanwhile at once, not on the next tick.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.querySelector('#sidebar .side-task.running')) void renderSidebar(); });
const SIDEBAR_KEY = 'oasis.sidebar';
function applySidebar() {
  let hidden = false;
  try { hidden = localStorage.getItem(SIDEBAR_KEY) === 'hidden'; } catch { /* storage blocked */ }
  document.documentElement.classList.toggle('side-hidden', hidden);
  const button = $('sidebarToggle');
  button.setAttribute('aria-expanded', String(!hidden));
  button.title = hidden ? 'Show sidebar' : 'Hide sidebar';
  button.setAttribute('aria-label', button.title);
  if (!hidden) void renderSidebar();
}
$('sidebarToggle').addEventListener('click', () => {
  const hidden = !document.documentElement.classList.contains('side-hidden');
  try { localStorage.setItem(SIDEBAR_KEY, hidden ? 'hidden' : 'shown'); } catch { /* storage blocked */ }
  applySidebar();
});
$('sideNewTask').addEventListener('click', async () => { await newChat(); void renderSidebar(); });
$('sideSearch').addEventListener('click', () => openNativeDialog('commandPaletteDialog'));
matchMedia('(min-width: 1100px)').addEventListener('change', () => void renderSidebar());
$('chatsButton').addEventListener('click', () => openChats());
$('newChatButton').addEventListener('click', async () => { closeSheet('chatsSheet'); await newChat(); });

async function restoreChat({ keepChat = false } = {}) {
  $('transcript').replaceChildren();
  showWholeChat = false;
  display = [];
  resetActivity();
  agent.reset();
  renderTodos([]);
  usageState.tokens = 0; usageState.context = null; usageState.cost = null; renderUsage();
  if (!workspace) { $('welcome').hidden = false; return; }
  if (!keepChat) chatId = (await chatIndex(workspace.project.id)).current || 'main';
  const saved = await store.getValue(chatKey(workspace.project.id, chatId));
  if (saved && saved.display && saved.display.length) {
    if (RT) agent.load(saved.messages);
    else agent.load(saved.messages, saved.pendingSteering);
    // A task that was running when this page last saved: show the chat up to
    // that turn, then replay and follow the task from the computer.
    const resumeId = RT && agent.resumeJobId && await agent.jobStatus(agent.resumeJobId) ? agent.resumeJobId : '';
    display = resumeId && Number.isInteger(saved.turnStart) ? saved.display.slice(0, saved.turnStart) : saved.display;
    renderSavedDisplay(display);
    scrollDown(true);
    // Keep where the turn starts: leaving this chat again saves it.
    if (resumeId) { turnStart = Number.isInteger(saved.turnStart) ? saved.turnStart : display.length; void resumeTurn(resumeId); }
  } else $('welcome').hidden = false;
  void renderSidebar();
}
async function resumeTurn(jobId) {
  if (agent.busy || !agent.resume) return;
  setBusy(true);
  let settle;
  turnEdited = false;
  turnPage = '';
  turnSettled = new Promise((resolve) => { settle = resolve; });
  try { await agent.resume(jobId); }
  catch { /* shown through the error event */ }
  finally { setBusy(false); if (!agent.detached) persistChat(); refreshFiles(); settle(); if (RT) refreshRuntimeStatus().then(updateProjectUI).catch(() => {}); }
}

/* ---------- Connector cards ---------- */
// The agent asked to connect an app (connect_service): an inline card in the
// conversation, under the step that asked. The task waits until it settles.
const liveConnectorCards = new Map();
function connectService(card, actions) {
  attention('input', 'OASIS wants to connect ' + String(card.connector && card.connector.name || 'an app') + '.');
  sound('input');
  removeThinking();
  const old = liveConnectorCards.get(card.id);
  if (old) old.stop();
  const ui = createConnectorCard(card, actions, { toast });
  const wrap = document.createElement('div');
  wrap.className = 'msg connector';
  wrap.appendChild(ui.element);
  $('transcript').appendChild(wrap);
  $('welcome').hidden = true;
  liveConnectorCards.set(card.id, ui);
  scrollDown(true);
  return ui.done.then((view) => {
    liveConnectorCards.delete(card.id);
    if (view.status === 'connected') { sound('done'); toast((view.connector && view.connector.name || 'App') + ' connected.'); }
    // Settled cards fold to one line after a moment; the step row keeps the record.
    setTimeout(() => wrap.classList.add('settled'), 2500);
    return view;
  });
}
// "/connect github", "connect my Linear account", "link notion": the card
// shows at once, no model turn needed. Plain sentences only count when they
// name a known app, so "connect the two functions" still goes to the agent.
let connectorList = null;
async function knownConnectors() {
  if (!connectorList) connectorList = RT.client.api('/api/connectors').then((body) => body.connectors || []).catch(() => { connectorList = null; return []; });
  return connectorList;
}
async function connectShortcut(message, { reason = '', keepInput = false } = {}) {
  const intent = connectIntent(message);
  if (!intent) return false;
  const list = await knownConnectors();
  const lookup = (service) => {
    const key = service.toLowerCase().replace(/[\s.]/g, '');
    return list.find((item) => [item.id, item.name, ...(item.aliases || [])].some((name) => String(name).toLowerCase().replace(/[\s.]/g, '') === key));
  };
  // "connect github and linear": one card per app, when every name is a known app.
  const parts = splitServices(intent.service);
  if (parts.length > 1 && parts.every(lookup)) {
    if (!reason) { $('input').value = ''; autosize(); }
    for (const part of parts) await connectShortcut('/connect ' + lookup(part).id, { reason, keepInput: true });
    return true;
  }
  const known = lookup(intent.service);
  if (!intent.explicit && !known) return false;
  if (!reason && !keepInput) { $('input').value = ''; autosize(); }
  if (!intent.service) {
    addMessage('note', 'Connect an app: /connect ' + list.map((item) => item.id).join(', /connect ') + ', or /connect followed by an MCP server URL.');
    scrollDown(true);
    return true;
  }
  if (known && (known.live || (known.connected && !known.expired))) { toast(known.name + ' is already connected. Disconnect it in Settings → Apps.'); return true; }
  let view;
  try { view = await RT.client.api('/api/connectors', { method: 'POST', body: { service: known ? known.id : intent.service, reason } }); }
  catch (error) { toast(String(error && error.message || error).replace(/^Error:\s*/, '')); return true; }
  const actions = {
    act: (body) => RT.client.api('/api/connectors/' + encodeURIComponent(view.id), { method: 'POST', body }),
    status: () => RT.client.api('/api/connectors/' + encodeURIComponent(view.id))
  };
  connectService(view, actions).then(() => { connectorList = null; });
  return true;
}
// Settings → Apps: every catalog app with its status and one Connect button.
async function renderApps() {
  const list = $('appList');
  connectorList = null;
  // Connected apps first, then ones this project uses, then the catalog order.
  const rank = (app) => (app.live || app.connected ? 2 : app.suggested ? 1 : 0);
  const apps = (await knownConnectors()).map((app, index) => ({ app, index })).sort((a, b) => rank(b.app) - rank(a.app) || a.index - b.index).map((item) => item.app);
  list.replaceChildren();
  for (const app of apps) {
    const row = document.createElement('li');
    const on = app.live || app.connected;
    row.className = 'app-tile' + (on ? ' on' : '');
    row.dataset.search = [app.id, app.name, app.description, ...(app.aliases || [])].join(' ').toLowerCase();
    row.appendChild(brandMark(app));
    const text = document.createElement('div');
    text.className = 'app-text';
    const name = document.createElement('strong');
    name.textContent = app.name;
    const sub = document.createElement('span');
    sub.textContent = app.expired && !app.live ? 'Sign-in expired' : on ? 'Connected' : app.suggested ? 'Used in this project (' + app.suggested + ')' : app.description;
    if (!on && app.suggested) row.classList.add('suggested');
    if (app.expired && !app.live) row.classList.add('expired');
    text.append(name, sub);
    row.appendChild(text);
    if (!on || (app.expired && !app.live)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn small';
      button.textContent = on ? 'Reconnect' : 'Connect';
      button.addEventListener('click', () => { closeSheet('settingsSheet'); void connectShortcut('/connect ' + app.id); });
      row.appendChild(button);
    } else {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'btn small ghost app-off';
      off.textContent = 'Disconnect';
      off.addEventListener('click', async () => {
        if (!confirm('Disconnect ' + app.name + '? OASIS forgets its sign-in; you can connect again any time.')) return;
        off.disabled = true;
        try { const result = await RT.client.api('/api/connectors', { method: 'POST', body: { service: app.id, action: 'disconnect' } }); toast(result.message || 'Disconnected.'); }
        catch (error) { toast(String(error && error.message || error).replace(/^Error:\s*/, '')); }
        void renderApps();
      });
      row.appendChild(off);
    }
    list.appendChild(row);
  }
  if (!apps.length) { const empty = document.createElement('li'); empty.className = 'hint'; empty.textContent = 'Could not load the app list from this computer.'; list.appendChild(empty); }
  filterApps();
}

/** Settings → Apps search: every word must match the name, id or description. */
function filterApps() {
  const input = $('appFilter');
  const list = $('appList');
  if (!input || !list) return;
  const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const row of list.querySelectorAll('.app-tile')) {
    const match = words.every((word) => row.dataset.search.includes(word));
    row.hidden = !match;
    if (match) shown += 1;
  }
  let none = list.querySelector('.app-none');
  if (!shown && words.length) {
    if (!none) { none = document.createElement('li'); none.className = 'hint app-none'; list.appendChild(none); }
    none.textContent = 'No app matches. Paste its MCP server URL in the message box: /connect https://…';
  } else if (none) none.remove();
}

/* ---------- Approvals ---------- */
let approvalResolve = null;
let approvalAlways = null;
async function requestApproval({ name, args, runtime = false }) {
  attention('input', 'OASIS needs your approval to continue.');
  sound('input');
  const summary = $('approvalSummary');
  const detail = $('approvalDetail');
  detail.replaceChildren();
  detail.hidden = false;
  $('allowAllButton').textContent = 'Allow all edits';
  $('allowAllButton').hidden = !['write_file', 'edit_file'].includes(name) || settings.mode !== 'ask';
  approvalAlways = null;
  // The "what to do instead" note goes to a running task. Approvals that no
  // task is waiting on (opening the terminal panel) hide it, so typing meant
  // for the terminal cannot land in it and deny with Enter.
  $('approvalInstead').value = '';
  $('approvalInstead').hidden = !(agent && agent.busy && typeof agent.steer === 'function');
  $('denyButton').textContent = 'Deny';
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
      $('allowAllButton').textContent = alwaysAllowLabel(args.suggestion);
      $('allowAllButton').title = 'Adds the rule ' + String(args.suggestion).slice(0, 200) + ' to this project';
    }
    openSheet('approvalSheet');
    markWaitingTools(true);
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
// While an approval is open, the step behind it is waiting on the user, not working.
function refreshWaitingRows() {
  const group = activeGroup;
  if (!group) return;
  for (const tool of group.steps) if (tool.waiting) updateStepRow(group, tool);
}
// Time a step spent waiting for your approval is kept apart from the time it
// ran, so a 4 s command approved after 20 s does not read as a 24 s command.
function setWaiting(tool, waiting) {
  if (waiting && !tool.waitStartedAt) tool.waitStartedAt = Date.now();
  if (!waiting && tool.waitStartedAt) { tool.waitedMs = (Number(tool.waitedMs) || 0) + Math.max(0, Date.now() - tool.waitStartedAt); delete tool.waitStartedAt; }
  tool.waiting = waiting;
}
function markWaitingTools(waiting) {
  const group = activeGroup;
  if (!group) return;
  for (const tool of group.steps) {
    if (tool.ok !== undefined || Boolean(tool.waiting) === waiting) continue;
    setWaiting(tool, waiting);
    updateStepRow(group, tool);
  }
  if (waiting && !group.el.classList.contains('open')) setGroupOpen(group, true);
  void renderSidebar();
}
function answerApproval(value) {
  markWaitingTools(false);
  const resolve = approvalResolve;
  approvalResolve = null;
  closeSheet('approvalSheet');
  if (resolve) resolve(value);
}
$('allowButton').addEventListener('click', () => answerApproval(true));
// Deny with a reason: the reason goes to the running task as a note, so the
// agent changes course instead of guessing why it was stopped.
$('denyButton').addEventListener('click', () => {
  const instead = $('approvalInstead').value.trim();
  $('approvalInstead').value = '';
  answerApproval(false);
  if (instead && agent.busy && typeof agent.steer === 'function') void agent.steer(instead);
});
$('approvalInstead').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('denyButton').click(); } });
$('approvalInstead').addEventListener('input', () => { $('denyButton').textContent = $('approvalInstead').value.trim() ? 'Deny and send' : 'Deny'; });
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
  sound('input');
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
  const shown = diff.slice(0, 1500);
  // Similar changed lines mark just the words that differ, as in the terminal.
  const words = wordHighlights(shown);
  shown.forEach((line, index) => {
    const div = document.createElement('div');
    div.className = line.type;
    const prefix = line.type === 'add' ? '+ ' : line.type === 'del' ? '− ' : line.type === 'same' ? '  ' : '';
    const segments = words.get(index);
    if (!segments) div.textContent = prefix + line.text;
    else {
      div.append(prefix);
      for (const segment of segments) {
        if (!segment.changed) { div.append(segment.text); continue; }
        const mark = document.createElement('mark');
        mark.textContent = segment.text;
        div.appendChild(mark);
      }
    }
    frag.appendChild(div);
  });
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
  // While OASIS works: Enter adds a note it reads at the next step,
  // Alt+Enter queues a message for when it finishes, Ctrl/Cmd+Enter stops
  // it and sends straight after, Esc stops (finished work stays).
  if (agent.busy && event.key === 'Enter' && !event.shiftKey && !event.isComposing && (event.altKey || event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    $('input').value = ''; autosize(); updateSteering();
    if (event.altKey) { pendingInputs.add('queued', text); return; }
    pendingInputs.add('interrupt', text);
    agent.stop();
    return;
  }
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
// A fileSuggestion command in the runtime's settings (as in the terminal) supplies "@" paths;
// null falls back to the file list. A runtime without the setting is asked only once.
async function commandFileSuggestions(query, seq) {
  if (!RT || RT.needsToken || suggest.noFileCommand) return null;
  // Typing fast should not start one command per key.
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (seq !== suggest.seq) return null;
  const body = await RT.client.api('/api/file-suggestions?q=' + encodeURIComponent(query)).catch(() => null);
  if (!body || !Array.isArray(body.paths)) { if (body && body.paths === null) suggest.noFileCommand = true; return null; }
  return body.paths.filter((item) => typeof item === 'string').slice(0, 15);
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
    } else if (suggest.token.kind === 'app') {
      name.textContent = item.name;
      detail.textContent = item.live || item.connected ? 'Connected' : item.suggested ? 'Used in this project' : item.description || '';
      row.append(brandMark(item), name, detail);
      row.classList.add('suggest-app');
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
    : token.kind === 'app' ? (RT && !RT.needsToken ? rankSuggestions(await knownConnectors().then((list) => token.query ? list : [...list].sort((a, b) => Number(Boolean(b.suggested && !b.connected)) - Number(Boolean(a.suggested && !a.connected)))), token.query, (item) => item.id, 8) : [])
    : (await commandFileSuggestions(token.query, seq)) || rankSuggestions(await filePathList(), token.query, (item) => item, 8);
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
  const next = applySuggestion(input.value, suggest.token, suggest.token.kind === '/' ? item.name : suggest.token.kind === 'app' ? item.id : item);
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
    if (event.key === 'Enter' && item && ((suggest.token.kind === '/' && item.name.toLowerCase() === suggest.token.query.toLowerCase()) || (suggest.token.kind === 'app' && item.id === suggest.token.query.toLowerCase()))) { closeSuggest(); return; }
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
  $('modelChip').textContent = entry ? entry.model.split('/').pop().replace(/:free$/, ' (free)') : RT && RT.needsToken ? 'Not signed in' : (innerWidth < 440 ? 'Connect' : 'Connect a model');
  $('modelChip').classList.toggle('empty', !entry);
  $('modelChip').title = entry ? entry.connection.label + ' · ' + entry.model : 'Paste an API key or model link to connect';
}

/* ---------- Model menu ---------- */
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
  anchorMenu(menu, $('modelChip'));
});
$('modeChip').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = $('modeMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  anchorMenu(menu, $('modeChip'));
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
// An empty folder has nothing to explain or fix yet: offer things to start.
const NEW_PROJECT_SUGGESTIONS = [
  'Build a small to-do web app in index.html, saved in localStorage',
  'Make a Node.js command-line tool with a test, using only built-ins',
  'Create a one-page portfolio site with a dark mode toggle',
  'Write a Python script that renames photos by the date they were taken'
];
function renderWelcome() {
  // Until the first status arrives only Fen shows, so "Paste a key" doesn't flash on a connected setup.
  $('welcome').classList.remove('booting');
  const ready = modelReady();
  const entry = activeEntry();
  $('connectForm').hidden = ready;
  $('welcomeTitle').textContent = RT && RT.needsToken ? 'Paste your OASIS link.' : ready ? 'What should we build?' : 'Paste a key to start.';
  $('connectInput').placeholder = RT && RT.needsToken ? 'Paste the link from your terminal' : 'Paste a key or link';
  $('connectHint').hidden = Boolean(RT && RT.needsToken);
  $('rememberRow').hidden = !(RT && RT.needsToken);
  if (RT && RT.needsToken) $('rememberDevice').checked = deviceRemembered();
  $('welcomeLede').textContent = RT && RT.needsToken
    ? RT.rateLimited ? 'Too many wrong access keys were tried from this computer, so OASIS paused sign-ins for about ' + Math.ceil(RT.rateLimited / 60) + ' minute' + (RT.rateLimited > 60 ? 's' : '') + '. This page reloads by itself when the pause ends.'
    : (RT.staleToken ? 'The saved access key no longer works; it may have been rotated. ' : 'OASIS is running on ' + location.host + '. ') + 'Paste the link or access key it printed (run oasis web key on that computer to see it again).'
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
  const fresh = Boolean(RT && RT.status && RT.status.workspaceEmpty);
  const SUGGESTION_ICONS = fresh ? ['check', 'plug', 'globe', 'book-open'] : ['eye', 'bug', 'check', 'globe'];
  if (ready) for (const [i, text] of (fresh ? NEW_PROJECT_SUGGESTIONS : SUGGESTIONS).entries()) {
    const chip = document.createElement('button');
    chip.className = 'suggestion';
    chip.style.setProperty('--i', String(i));
    chip.innerHTML = icon(SUGGESTION_ICONS[i % 4]) + '<span></span>';
    chip.querySelector('span').textContent = text;
    chip.addEventListener('click', () => { $('input').value = text; autosize(); renderPluginSuggest(); $('input').focus(); });
    box.appendChild(chip);
  }
  if (ready && RT && !RT.needsToken) void renderWelcomeApps(box);
}

// "This project uses Vercel and Stripe": one-click Connect chips on the new-chat screen.
let welcomeAppsToken = 0;
async function renderWelcomeApps(box) {
  const token = ++welcomeAppsToken;
  const apps = (await knownConnectors().catch(() => [])).filter((app) => app.suggested && !app.live && !app.connected).slice(0, 4);
  if (token !== welcomeAppsToken || !apps.length || !box.isConnected) return;
  box.querySelector('.welcome-apps')?.remove();
  const row = document.createElement('div');
  row.className = 'welcome-apps';
  row.appendChild(Object.assign(document.createElement('span'), { className: 'welcome-apps-label', textContent: 'This project uses' }));
  for (const app of apps) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggestion app-chip';
    chip.title = 'Connect ' + app.name + ' (found ' + app.suggested + ')';
    chip.append(brandMark(app), Object.assign(document.createElement('span'), { textContent: 'Connect ' + app.name }));
    chip.addEventListener('click', () => { chip.disabled = true; void connectShortcut('/connect ' + app.id, { keepInput: true }).finally(() => { connectorList = null; }); row.remove(); });
    row.appendChild(chip);
  }
  box.appendChild(row);
}

/* ---------- Plugins ---------- */
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
  head.querySelector('.plugin-icon').innerHTML = icon(plugin.icon);
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
  $('ccPlugins').hidden = !mcpAvailable();
  if (mcpAvailable() && !ccLoading) void refreshClaudePlugins();
}
// Claude Code plugins on the computer running `oasis web` (/api/plugins).
let ccOverview = { installed: [], marketplaces: [] };
let ccLoading = false;
function ccStatus(text, kind = '') { const node = $('ccStatus'); node.textContent = text; node.className = 'test-result' + (kind === 'error' ? ' fail' : ''); }
function ccButton(label, aria, kind, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn small' + (kind ? ' ' + kind : '');
  button.textContent = label;
  button.setAttribute('aria-label', aria);
  button.addEventListener('click', onClick);
  return button;
}
function ccRow(title, detail, buttons) {
  const li = document.createElement('li');
  const info = document.createElement('div');
  info.className = 'connection-info';
  const strong = document.createElement('strong');
  strong.textContent = title;
  info.append(strong);
  if (detail) { const span = document.createElement('span'); span.textContent = detail; info.append(span); }
  const actions = document.createElement('div');
  actions.className = 'row';
  actions.append(...buttons);
  li.append(info, actions);
  return li;
}
function renderClaudePlugins() {
  const oldOffer = document.getElementById('ccOffer');
  if (oldOffer) oldOffer.remove();
  const installed = $('ccInstalled');
  installed.replaceChildren(...ccOverview.installed.map((plugin) => ccRow(
    plugin.name + (plugin.enabled ? '' : ' (off)'),
    [plugin.marketplace, plugin.version ? 'v' + plugin.version : '', plugin.description].filter(Boolean).join(' · '),
    [
      ccButton(plugin.enabled ? 'Turn off' : 'Turn on', (plugin.enabled ? 'Turn off ' : 'Turn on ') + plugin.name, '', () => void ccAction(plugin.enabled ? 'disable' : 'enable', plugin.id)),
      ...(plugin.fromClaudeCode ? [] : [ccButton('Remove', 'Remove ' + plugin.name, 'ghost', () => { if (confirm('Remove the plugin "' + plugin.name + '"?')) void ccAction('uninstall', plugin.id); })])
    ]
  )));
  installed.hidden = !ccOverview.installed.length;
  const results = $('ccResults');
  const count = marketplaceCount(ccOverview);
  $('ccMarket').hidden = !count;
  if (!ccOverview.marketplaces.length) {
    results.replaceChildren();
    const offer = ccRow('Anthropic plugin marketplace', 'About 300 plugins, including frontend-design, superpowers, code-review, context7 and playwright.', [
      ccButton('Add it', 'Add the Anthropic plugin marketplace', '', () => void ccAction('add-marketplace', OFFICIAL_MARKETPLACE))
    ]);
    // A bare <li> after the installed list rendered with a stray bullet and
    // without the bordered row style, so the offer gets its own list.
    const list = document.createElement('ul');
    list.className = 'connection-list';
    list.id = 'ccOffer';
    list.append(offer);
    $('ccInstalled').after(list);
    return;
  }
  const items = searchMarketplace(ccOverview, $('ccSearch').value, 24);
  results.replaceChildren(...items.map((item) => ccRow(
    item.name,
    item.description.slice(0, 160),
    item.installed ? [Object.assign(document.createElement('span'), { className: 'hint', textContent: 'Installed' })]
      : [ccButton('Install', 'Install ' + item.name, '', () => {
        if (confirm('Install "' + item.name + '" from ' + item.marketplace + '? Its hooks and MCP servers will run on this computer in new chats.')) void ccAction('install', item.id);
      })]
  )));
  if (!items.length) results.replaceChildren(ccRow('No plugins match', 'Try a shorter word.', []));
}
async function refreshClaudePlugins() {
  ccLoading = true;
  try { ccOverview = await RT.client.api('/api/plugins'); ccStatus(''); }
  catch (error) { ccOverview = { installed: [], marketplaces: [] }; ccStatus('Could not load plugins: ' + error.message, 'error'); }
  finally { ccLoading = false; }
  renderClaudePlugins();
}
async function ccAction(action, target) {
  const busy = { install: 'Installing ', uninstall: 'Removing ', enable: 'Turning on ', disable: 'Turning off ', 'add-marketplace': 'Downloading ' }[action] || '';
  ccStatus(busy + target + '…');
  try {
    const result = await RT.client.api('/api/plugins', { method: 'POST', body: { action, target } });
    ccOverview = { installed: result.installed || [], marketplaces: result.marketplaces || [] };
    renderClaudePlugins();
    ccStatus(result.message || 'Done.');
    if (action !== 'add-marketplace') toast(result.message || 'Done.');
  } catch (error) { ccStatus(error.message, 'error'); }
}
$('ccSearch').addEventListener('input', () => renderClaudePlugins());
$('ccMarketAdd').addEventListener('click', () => {
  const source = $('ccMarketInput').value.trim();
  if (!source) { ccStatus('Enter a repository such as ' + OFFICIAL_MARKETPLACE + '.', 'error'); return; }
  void ccAction('add-marketplace', source).then(() => { $('ccMarketInput').value = ''; $('ccAddMarket').open = false; });
});
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
/* MCP servers live in the runtime's config (~/.oasis/mcp.json), so this
   section only appears when the page is connected to `oasis web`. */
let mcpServers = [];
function mcpAvailable() { return Boolean(RT && RT.client && !RT.needsToken); }
function mcpSetStatus(text, kind = '') { const node = $('mcpStatus'); node.textContent = text; node.className = 'test-result' + (kind === 'error' ? ' fail' : ''); }
function renderMcpList(message = '') {
  const list = $('mcpList');
  list.replaceChildren();
  if (message || !mcpServers.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = message || 'No MCP servers yet. Servers in a project .mcp.json also load once you trust the project with oasis trust.';
    list.appendChild(li);
    return;
  }
  for (const server of mcpServers) {
    const li = document.createElement('li');
    li.className = 'connection mcp-server' + (server.enabled ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'connection-info';
    const title = document.createElement('strong');
    title.textContent = server.name + (server.enabled ? '' : ' (off)');
    const detail = document.createElement('span');
    detail.textContent = describeMcpServer(server);
    info.append(title, detail);
    if (server.passEnv && server.passEnv.length) {
      const env = document.createElement('span');
      env.textContent = 'reads ' + server.passEnv.join(', ');
      info.append(env);
    }
    if (server.origin && server.origin.repository) {
      const origin = document.createElement('span');
      origin.textContent = 'from ' + server.origin.repository + (server.origin.commitSha ? ' @ ' + String(server.origin.commitSha).slice(0, 12) : '');
      info.append(origin);
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn small';
    toggle.textContent = server.enabled ? 'Turn off' : 'Turn on';
    toggle.setAttribute('aria-label', (server.enabled ? 'Turn off ' : 'Turn on ') + server.name);
    toggle.addEventListener('click', () => {
      if (!server.enabled && !confirm('Turn on "' + server.name + '"? It runs this program on your computer when a new chat starts:\n\n' + describeMcpServer(server))) return;
      void saveMcp(mcpServers.map((s) => (s.name === server.name ? { ...s, enabled: !s.enabled } : s)), server.enabled ? server.name + ' turned off.' : server.name + ' turned on.');
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn small ghost';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + server.name);
    remove.addEventListener('click', () => {
      if (!confirm('Remove the MCP server "' + server.name + '"?')) return;
      void saveMcp(mcpServers.filter((s) => s.name !== server.name), server.name + ' removed.');
    });
    const actions = document.createElement('div');
    actions.className = 'row';
    actions.append(toggle, remove);
    li.append(info, actions);
    list.appendChild(li);
  }
}
async function refreshMcp() {
  if (!mcpAvailable()) return;
  try { mcpServers = (await RT.client.api('/api/mcp')).servers || []; renderMcpList(); }
  catch (error) { mcpServers = []; renderMcpList('Could not load MCP servers: ' + error.message); }
}
async function saveMcp(next, done) {
  try {
    const result = await RT.client.api('/api/mcp', { method: 'POST', body: { servers: next } });
    mcpServers = result.servers || [];
    renderMcpList();
    toast(done + ' Applies to new chats.');
    return true;
  } catch (error) { toast('Could not save MCP servers: ' + error.message, 'error'); return false; }
}
$('mcpAddButton').addEventListener('click', async () => {
  let server;
  try { server = mcpServerFromForm({ name: $('mcpName').value, command: $('mcpCommand').value, env: $('mcpEnv').value }); }
  catch (error) { mcpSetStatus(error.message, 'error'); return; }
  if (mcpServers.some((s) => s.name === server.name)) { mcpSetStatus('A server named ' + server.name + ' already exists.', 'error'); return; }
  if (!confirm('Add "' + server.name + '"? OASIS will run this program on your computer when a new chat starts:\n\n' + describeMcpServer(server))) return;
  mcpSetStatus('Saving…');
  if (await saveMcp([...mcpServers, server], server.name + ' added.')) {
    for (const id of ['mcpName', 'mcpCommand', 'mcpEnv']) $(id).value = '';
    mcpSetStatus('');
    $('mcpAdd').open = false;
  } else mcpSetStatus('');
});
// Routines (`oasis schedule`) on the computer running `oasis web` (/api/routines).
let routineItems = [];
function routineSetStatus(text, kind = '') { const node = $('routineStatus'); node.textContent = text; node.className = 'test-result' + (kind === 'error' ? ' fail' : ''); }
function renderRoutines(data, problem = '') {
  routineItems = (data && data.routines) || [];
  $('routineScheduler').textContent = problem || (data && data.scheduler === 'running' ? 'The scheduler is running.' : 'The scheduler is not running, so routines will not fire until oasis web restarts or you run oasis schedule daemon.');
  const list = $('routineList');
  list.replaceChildren();
  if (!routineItems.length && !problem) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'No routines yet. You can also ask the agent, for example: check CI every weekday at 9.'; list.appendChild(li); }
  for (const job of routineItems) {
    const li = document.createElement('li');
    li.className = 'connection routine' + (job.enabled ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'connection-info';
    const title = document.createElement('strong');
    title.textContent = (job.name || job.id) + ' · ' + job.state;
    const when = document.createElement('span');
    when.textContent = job.schedule + (job.timezone ? ' (' + job.timezone + ')' : '') + (job.nextRunAt ? ' · next ' + new Date(job.nextRunAt).toLocaleString() : '') + (job.lastStatus ? ' · last ' + job.lastStatus : '');
    const what = document.createElement('span');
    what.textContent = (job.kind === 'script' ? '$ ' : '') + job.prompt.slice(0, 160) + (job.deliver && job.deliver !== 'local' ? ' → ' + job.deliver : '');
    info.append(title, when, what);
    if (job.webhookPath) {
      const hook = document.createElement('span');
      hook.textContent = 'POST ' + location.origin + job.webhookPath + ' · sign with secret ' + job.webhookSecret + (job.pendingEvents ? ' · ' + job.pendingEvents + ' waiting' : '');
      info.append(hook);
    }
    if (job.pausedReason || job.lastProblem) { const note = document.createElement('span'); note.textContent = job.lastProblem || job.pausedReason; info.append(note); }
    const actions = document.createElement('div');
    actions.className = 'row';
    const button = (label, action, ghost = false) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small' + (ghost ? ' ghost' : ''); b.textContent = label;
      b.setAttribute('aria-label', label + ' ' + (job.name || job.id));
      b.addEventListener('click', () => {
        if (action === 'remove' && !confirm('Delete the routine "' + (job.name || job.id) + '"?')) return;
        void routineAction({ action, id: job.id }, label + ': ' + (job.name || job.id));
      });
      actions.append(b);
    };
    if (job.state === 'running') button('Stop run', 'cancel');
    else button('Run now', 'run');
    button(job.enabled ? 'Pause' : 'Resume', job.enabled ? 'pause' : 'resume');
    button('Remove', 'remove', true);
    const results = document.createElement('details');
    results.className = 'routine-results';
    const summary = document.createElement('summary');
    summary.textContent = 'Recent results';
    const body = document.createElement('div');
    results.append(summary, body);
    results.addEventListener('toggle', async () => {
      if (!results.open) return;
      body.textContent = 'Loading…';
      try {
        const data = await RT.client.api('/api/routines?runs=' + encodeURIComponent(job.id));
        body.replaceChildren();
        if (!data.runs.length) body.textContent = 'No runs yet.';
        for (const run of data.runs) {
          const head = document.createElement('div');
          head.className = 'hint';
          head.textContent = [run.finishedAt ? new Date(run.finishedAt).toLocaleString() : 'running', run.status, run.manual ? 'manual' : '', run.event ? 'webhook' : '', run.reason, run.deliveryError ? 'delivery failed: ' + run.deliveryError : run.delivery ? 'sent to ' + run.delivery : ''].filter(Boolean).join(' · ');
          body.appendChild(head);
          if (run.output) { const pre = document.createElement('pre'); pre.className = 'routine-output'; pre.textContent = run.output; body.appendChild(pre); }
        }
      } catch (error) { body.textContent = 'Could not load results: ' + error.message; }
    });
    info.append(results);
    li.append(info, actions);
    list.appendChild(li);
  }
}
async function refreshRoutines() {
  if (!mcpAvailable()) return;
  try { renderRoutines(await RT.client.api('/api/routines')); }
  catch (error) { renderRoutines(null, 'Could not load routines: ' + error.message); }
}
async function routineAction(body, done) {
  try { renderRoutines(await RT.client.api('/api/routines', { method: 'POST', body })); toast(done); return true; }
  catch (error) { toast('Routine not changed: ' + error.message, 'error'); return false; }
}
$('routineAddButton').addEventListener('click', async () => {
  const fields = { name: $('routineName').value.trim(), schedule: $('routineSchedule').value.trim(), prompt: $('routinePrompt').value.trim(), kind: $('routineScript').checked ? 'script' : 'agent', deliver: $('routineDeliver').value.trim() };
  if (!fields.schedule || !fields.prompt) { routineSetStatus('Add a schedule and a task.', 'error'); return; }
  if (fields.kind === 'script' && !confirm('This command will run on your computer on schedule "' + fields.schedule + '":\n\n' + fields.prompt)) return;
  routineSetStatus('Saving…');
  if (await routineAction({ action: 'create', fields }, 'Routine added.')) {
    for (const id of ['routineName', 'routineSchedule', 'routinePrompt', 'routineDeliver']) $(id).value = '';
    $('routineScript').checked = false;
    $('routineAdd').open = false;
  }
  routineSetStatus('');
});
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
  $('soundInput').checked = Boolean(settings.sounds);
  $('densityVerbose').checked = settings.density === 'verbose';
  $('githubToken').value = settings.githubToken;
  $('testResult').textContent = '';
  $('versionLabel').textContent = APP_VERSION;
  for (const id of ['manualSetup', 'githubSettings', 'maxStepsField']) if ($(id)) $(id).hidden = Boolean(RT);
  $('autoSwitch').closest('label').hidden = Boolean(RT);
  $('runtimeInfo').hidden = !RT;
  if (RT && RT.status) $('runtimeInfo').textContent = 'Running on this computer in ' + (RT.status.workspacePath || RT.status.workspaceName) + '. Model keys are saved by OASIS on this computer, and backup models take over automatically.';
  $('wipeAll').hidden = Boolean(RT);
  $('appSettings').hidden = !RT || RT.needsToken;
  if (RT && !RT.needsToken) void renderApps();
  $('mcpSettings').hidden = !mcpAvailable();
  if (mcpAvailable()) { mcpSetStatus(''); void refreshMcp(); }
  $('routineSettings').hidden = !mcpAvailable();
  if (mcpAvailable()) { routineSetStatus(''); void refreshRoutines(); }
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
    maxSteps: Math.min(500, Math.max(5, Number($('maxStepsInput').value) || 100)),
    theme: $('themeSelect').value,
    notify: $('notifyInput').checked,
    sounds: $('soundInput').checked,
    density: $('densityVerbose').checked ? 'verbose' : 'normal',
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
  await deleteDB('oasis-universal').catch(() => {});
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
    del.innerHTML = icon('trash-2');
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
  hint.textContent = 'To work in another folder, run oasis web there.';
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
// oasis web: picked files (documents, images, PDFs) go into the real project
// folder on disk, where the agent can read them.
async function uploadToRuntime(picked) {
  const files = [];
  let tooLarge = 0;
  for (const file of picked.slice(0, 200)) {
    if (file.size > 10 * 1048576) { tooLarge++; continue; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    files.push({ path: file.name, base64: btoa(binary) });
  }
  if (!files.length) { toast(tooLarge ? 'Files larger than 10 MB cannot be added here.' : 'No files to add.', 'error'); return; }
  let result;
  try { result = await workspace.upload(files); }
  catch (error) {
    const existing = error && error.data && Array.isArray(error.data.existing) ? error.data.existing : null;
    if (!existing || !existing.length) throw error;
    if (!confirm('Replace ' + existing.length + ' existing file' + (existing.length === 1 ? '' : 's') + ' in "' + workspace.project.name + '"?\n' + existing.slice(0, 8).join('\n'))) return;
    result = await workspace.upload(files, { overwrite: true });
  }
  refreshFiles();
  closeSheet('projectsSheet');
  const refused = (result.refused || []).map((item) => item.path + ' (' + item.reason + ')');
  toast('Added ' + result.written.length + ' file' + (result.written.length === 1 ? '' : 's') + ' to ' + workspace.project.name + (refused.length ? '. Skipped ' + refused.join(', ') : '') + (tooLarge ? '. Skipped ' + tooLarge + ' over 10 MB' : '') + '.', refused.length ? 'error' : undefined);
}
for (const id of ['folderInput', 'filesInput']) {
  $(id).addEventListener('change', async (event) => {
    const input = event.target;
    if (!input.files || !input.files.length) return;
    try {
      if (workspace && typeof workspace.upload === 'function' && id === 'filesInput') {
        await uploadToRuntime([...input.files]);
        input.value = '';
        return;
      }
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
  $('projectName').textContent = workspace ? workspace.project.name : RT ? (RT.needsToken ? location.hostname : 'This computer') : 'No project';
  const branch = RT && RT.status && RT.status.branch;
  $('projectBranch').hidden = !branch;
  $('projectBranch').textContent = branch || '';
  $('projectBranch').title = branch ? 'Git branch: ' + branch : '';
  const github = workspace && workspace.project.source && workspace.project.source.type === 'github';
  $('pushButton').hidden = !github || Boolean(RT);
  $('exportButton').hidden = Boolean(RT);
  $('newFileButton').hidden = Boolean(RT);
  $('terminalTab').hidden = !(RT && !RT.needsToken);
  $('previewTab').hidden = $('terminalTab').hidden;
  if ($('terminalTab').hidden && (!$('terminalView').hidden || !$('previewView').hidden)) showPanelTab('files');
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
  const handle = document.getElementById('panelResize');
  if (handle) { handle.setAttribute('aria-valuenow', String(width)); handle.setAttribute('aria-valuetext', width + ' pixels'); }
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
  $('activityView').hidden = name !== 'activity';
  $('fileList').hidden = name !== 'files';
  $('changesList').hidden = name !== 'changes';
  $('terminalView').hidden = name !== 'terminal';
  $('previewView').hidden = name !== 'preview';
  $('fileFilter').parentElement.hidden = name !== 'files';
  $('panelFoot').hidden = name === 'terminal' || name === 'preview' || name === 'activity' || ($('exportButton').hidden && $('pushButton').hidden);
  if (name === 'terminal') void openTerminal();
  if (name === 'preview') void openPreview();
  if (name === 'activity') refreshActivity();
  localStorage.setItem('oasis.panelTab', name === 'terminal' || name === 'preview' ? 'files' : name);
}
function currentPanelTab() { const tab = document.querySelector('#filesPanel .tab.active'); return tab ? tab.dataset.tab : 'files'; }
// The Activity button opens the run timeline beside the chat, or closes it.
function toggleActivity(force) {
  const showing = !$('filesPanel').hidden && currentPanelTab() === 'activity';
  const show = force === undefined ? !showing : force;
  if (!show) { if (showing) toggleFiles(false); return; }
  toggleFiles(true);
  showPanelTab('activity');
}
$('activityButton').addEventListener('click', () => toggleActivity());
function showStepInChat(id) {
  const row = id && document.querySelector('#transcript .tool[data-id="' + CSS.escape(id) + '"]');
  if (!row) { toast('That step is no longer in the conversation view.'); return; }
  const group = groupOf.get(row.closest('.steps'));
  if (group) setGroupOpen(group, true);
  const details = row.querySelector('details');
  if (details && !details.open) details.open = true;
  if (innerWidth < 1024) toggleFiles(false);
  row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1400);
}
function downloadText(name, text) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}
initActivity({
  entries: () => display,
  running: () => Boolean(agent && agent.busy),
  timings: () => runTimings,
  iconFor: kindIcon,
  fillInspector,
  showInChat: showStepInChat,
  copyText,
  toast,
  download: downloadText,
  title: chatTitle,
  openActivity: () => toggleActivity(true)
});
for (const tab of document.querySelectorAll('#filesPanel .tab')) tab.addEventListener('click', () => showPanelTab(tab.dataset.tab));

/* ---------- Preview (project files or a dev server, sandboxed) ---------- */
const preview = { base: '', address: localStorage.getItem('oasis.previewAddress') || '', recordings: [], designs: [], loaded: false };
function previewUrl(address, { direct = false } = {}) {
  const target = previewTarget(address);
  // Opened in its own tab on this computer, a dev server is reached directly (live reload works).
  if (direct && target.port && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return 'http://' + location.hostname + ':' + target.port + '/' + target.path;
  if (!preview.base) return '';
  return target.port ? preview.base + ':' + target.port + '/' + target.path : preview.base + target.path.split('/').map(encodeURIComponent).join('/');
}
async function guessPreviewAddress() {
  const files = await workspace.paths().catch(() => []);
  return ['index.html', 'public/index.html', 'dist/index.html', 'build/index.html', 'docs/index.html'].find((name) => files.includes(name))
    || files.find((name) => /\.html?$/i.test(name)) || 'index.html';
}
function renderPreviewChips() {
  const chips = $('previewChips');
  chips.replaceChildren();
  for (const design of preview.designs.slice(0, 4)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Artboards: ' + design.name;
    button.title = 'Compare ' + design.files.length + ' variants in design/' + design.name + ' side by side';
    button.classList.toggle('active', designName(preview.address) === design.name);
    button.addEventListener('click', () => loadPreview('design:' + design.name));
    chips.append(button);
  }
  for (const file of preview.recordings.slice(0, 3)) {
    const button = document.createElement('button');
    button.type = 'button';
    const stamp = file.replace(/^.*browser-/, '').replace(/\.html$/, '').replace(/T(\d\d)-(\d\d).*$/, ' $1:$2');
    button.textContent = 'Recording ' + stamp;
    button.title = 'Play the browser recording ' + file;
    button.classList.toggle('active', preview.address === file);
    button.addEventListener('click', () => loadPreview(file));
    chips.append(button);
  }
}
// "design:NAME" (or the folder design/NAME/) shows that exploration's variants as artboards.
function designName(address) {
  const match = /^(?:design:|design\/)([\w.-]+)\/?$/.exec(String(address || '').trim());
  return match ? match[1] : '';
}
function fitArtboards() {
  for (const view of document.querySelectorAll('#previewBoards .artboard-view')) {
    const frame = view.querySelector('iframe');
    if (frame) frame.style.transform = 'scale(' + (view.clientWidth / 1280) + ')';
  }
}
function renderArtboards(name) {
  const boards = $('previewBoards');
  boards.replaceChildren();
  const design = preview.designs.find((entry) => entry.name === name);
  if (!design) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'No variants in design/' + name + '/ yet. Ask OASIS: /design ' + name.replace(/-/g, ' ');
    boards.append(note);
    return;
  }
  for (const file of design.files) {
    const label = file.split('/').pop().replace(/\.html?$/i, '');
    const card = document.createElement('section');
    card.className = 'artboard';
    const head = document.createElement('div');
    head.className = 'artboard-head';
    const title = document.createElement('strong');
    title.textContent = label;
    title.title = file;
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Open';
    open.title = 'Open ' + file + ' full size';
    open.addEventListener('click', () => loadPreview(file));
    const use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Use this';
    use.title = 'Ask OASIS to build this variant';
    use.addEventListener('click', () => {
      const input = $('input');
      input.value = 'Use the ' + label + ' variant (' + file + ') from the ' + design.name + ' design exploration. Implement it in the real codebase with the project\'s existing framework and components.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
    head.append(title, open, use);
    const view = document.createElement('div');
    view.className = 'artboard-view';
    const frame = document.createElement('iframe');
    frame.title = 'Variant ' + label;
    frame.loading = 'lazy';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.tabIndex = -1;
    frame.src = previewUrl(file);
    view.append(frame);
    card.append(head, view);
    boards.append(card);
  }
  requestAnimationFrame(fitArtboards);
}
if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitArtboards()).observe($('previewBoards'));
function loadPreview(address) {
  preview.address = String(address || '').trim();
  localStorage.setItem('oasis.previewAddress', preview.address);
  $('previewAddress').value = preview.address;
  const name = designName(preview.address);
  $('previewBoards').hidden = !name;
  $('previewFrame').hidden = Boolean(name);
  if (name) renderArtboards(name);
  else {
    const url = previewUrl(preview.address);
    if (url) $('previewFrame').src = url;
  }
  renderPreviewChips();
}
async function openPreview() {
  if (!RT || RT.needsToken) return;
  try {
    const info = await RT.client.api('/api/preview');
    preview.base = info.base;
    preview.recordings = info.recordings || [];
    preview.designs = info.designs || [];
  } catch (error) { toast('Preview is not available: ' + (error.message || error)); return; }
  if (!preview.loaded) { preview.loaded = true; loadPreview(preview.address || await guessPreviewAddress()); }
  else renderPreviewChips();
}
function reloadPreview() {
  if (designName(preview.address)) { renderArtboards(designName(preview.address)); return; }
  const frame = $('previewFrame');
  if (!frame.src) return;
  // A sandboxed page has its own origin, so reload by setting the address again.
  const src = frame.src;
  frame.src = 'about:blank';
  requestAnimationFrame(() => { frame.src = src; });
}
function refreshPreviewIfOpen() {
  if ($('previewView').hidden || $('filesPanel').hidden) return;
  void openPreview().then(reloadPreview);
}
$('previewForm').addEventListener('submit', (event) => { event.preventDefault(); loadPreview($('previewAddress').value); });
$('previewReload').addEventListener('click', reloadPreview);
$('previewPopout').addEventListener('click', () => { if (designName(preview.address)) return; const url = previewUrl(preview.address, { direct: true }); if (url) window.open(url, '_blank', 'noopener'); });

/* ---------- Terminal (connected to OASIS on a computer) ---------- */
let terminal = null;
let xterm = null;
let fitTerminal = null;
function termTheme() {
  return { background: '#0C0E0D', foreground: '#ECEFED', cursor: '#3FD68F', selectionBackground: '#3FD68F40' };
}
async function openTerminal() {
  if (!RT || RT.needsToken) { $('terminalStatus').textContent = 'Connect to OASIS on a computer to use a terminal.'; return; }
  if (!xterm) {
    try { await loadXterm(); } catch (error) { $('terminalStatus').textContent = error.message; return; }
    const Fit = globalThis.FitAddon && (globalThis.FitAddon.FitAddon || globalThis.FitAddon);
    xterm = new globalThis.Terminal({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, cursorBlink: true, convertEol: false, scrollback: 5000, theme: termTheme() });
    if (typeof Fit === 'function') { const fit = new Fit(); xterm.loadAddon(fit); fitTerminal = () => { try { fit.fit(); } catch { /* hidden */ } }; }
    xterm.open($('terminalHost'));
    // Before a shell runs, the pane used to show a blinking cursor that ignored
    // typing. Enter now starts one (the approval prompt still applies).
    xterm.onData((data) => {
      if (terminal && terminal.running) { void terminal.write(data); return; }
      if (data.includes('\r') && !$('terminalStart').hidden && !$('terminalStart').disabled) $('terminalStart').click();
    });
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
  if (!(terminal && terminal.running)) requestAnimationFrame(() => { if (fitTerminal) fitTerminal(); terminalIdleHint(); });
}
function terminalNote(text) {
  for (const row of wrapWords(text, xterm.cols)) xterm.writeln('\x1b[2m' + row + '\x1b[0m');
}
let terminalHintShown = false;
function terminalIdleHint() {
  if (terminalHintShown || !xterm || (terminal && terminal.running)) return;
  terminalHintShown = true;
  terminalNote('Press Enter or select Start terminal to open a shell in this project.');
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
        xterm.writeln('');
        terminalNote('[process exited] Press Enter to start a new shell.');
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
  suggest.noFileCommand = false;
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
    for (const id of ['deleteFileButton', 'saveFileButton']) $(id).hidden = true;
    // Discard: back to the last commit. New (untracked) files have no committed version.
    $('revertButton').hidden = !status || status === 'added';
    $('revertButton').textContent = 'Discard';
    $('revertButton').title = 'Discard these changes and restore the last committed version';
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
  $('revertButton').textContent = 'Revert';
  $('revertButton').title = '';
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
$('revertButton').addEventListener('click', async () => {
  if (RT) {
    if (!confirm('Discard your changes to ' + editingPath + ' and restore the last committed version? This cannot be undone.')) return;
    try { await workspace.discard(editingPath); }
    catch (error) { toast(error.message || String(error)); return; }
    refreshFiles(); closeSheet('editorSheet'); toast('Restored ' + editingPath + ' from the last commit');
    return;
  }
  if (!confirm('Revert ' + editingPath + ' to how it was when opened?')) return;
  await workspace.revert(editingPath); refreshFiles(); closeSheet('editorSheet'); toast('Reverted ' + editingPath);
});
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
  RT = { client: found.client, status: found.status || null, needsToken: Boolean(found.needsToken), staleToken: Boolean(found.staleToken), rateLimited: Number(found.rateLimited) || 0, entry: null, models: [], label: '' };
  if (RT.needsToken) {
    if (RT.rateLimited) setTimeout(() => location.reload(), (RT.rateLimited + 1) * 1000);
    updateProjectUI();
    updateModeUI();
    await restoreChat();
    renderSidebar();
    return;
  }
  // The key stopped working mid-session (the server restarted with a new one): go back to
  // the sign-in screen instead of failing every request with the same error.
  RT.client.onUnauthorized = () => {
    if (RT.signedOut) return;
    RT.signedOut = true;
    forgetRuntimeToken();
    toast('This OASIS link is out of date. Open the new link from the terminal.');
    setTimeout(() => location.reload(), 1500);
  };
  RT.rootPath = RT.status.workspacePath;
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
    connect: connectService,
    getMode: () => currentMode()
  });
  workspace = new RuntimeWorkspace(RT.client, RT.status);
  updateModeUI();
  updateProjectUI();
  await restoreChat();
  void syncBrowserOnlyChats();
}

// Browser-only chats are copied to the computer's session store once connected (core/chat-sync.mjs).
async function syncBrowserOnlyChats() {
  if (!RT || RT.needsToken || RT.chatsSyncing) return 0;
  RT.chatsSyncing = true;
  let result = { copied: 0 };
  try { result = await syncBrowserChats({ store, api: (path, options) => RT.client.api(path, options), chatIndex, chatKey }); }
  catch { /* tried again on the next connection */ }
  finally { if (RT) RT.chatsSyncing = false; }
  if (result.copied) { toast(result.copied === 1 ? 'Copied 1 browser-only chat to this computer.' : 'Copied ' + result.copied + ' browser-only chats to this computer.'); renderSidebar(); }
  return result.copied;
}

/* ---------- Updates ---------- */
// On a computer, the runtime knows whether a newer OASIS is out. One slim bar,
// never a dialog: it copies the one command to run (oasis update).
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
  $('updateDetail').textContent = 'You have ' + state.current + '. Your chats and keys stay.';
  // The desktop app can install a checksum-verified installer itself; the
  // CLI-hosted workspace copies the one command to run.
  $('updateAction').textContent = state.host === 'desktop' ? (state.canInstall ? 'Install and restart' : 'Download') : 'Copy “oasis update”';
}
function setupUpdates() {
  $('updateAction').addEventListener('click', async () => {
    const state = updateState;
    if (!state) return;
    if (state.host === 'desktop') {
      // The desktop host confirms with a native dialog before it installs.
      const done = await RT.client.api('/api/app/update', { method: 'POST', body: { action: 'install' } }).catch((error) => ({ error: String(error && error.message || error) }));
      if (done && done.error) toast('Could not start the update: ' + done.error);
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
  if (Recognition) {
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

/* ---------- Talk mode ---------- */
// A hands-free voice conversation: OASIS listens, sends what you said when you stop
// talking, works on it, reads the reply aloud and listens again. Say "stop talking"
// or press End (or Escape) to finish. Replies are read with the configured speech
// model when OASIS has one, otherwise with the browser's own voice.
const talk = { on: false, state: 'off', cancel: null, audio: null, speechApi: null };
function setTalkState(state, heard = '') {
  talk.state = state;
  const bar = $('talkBar');
  bar.hidden = state === 'off';
  bar.dataset.state = state;
  $('talkState').textContent = { listening: 'Listening', hearing: 'Listening', sending: 'Sending', working: 'Working on it', speaking: 'Speaking', off: '' }[state] || state;
  $('talkHeard').textContent = heard ? '"' + heard.slice(0, 160) + '"' : state === 'listening' ? 'Say what you want built or fixed. Say "stop talking" to end.' : '';
  $('talkSkip').hidden = state !== 'speaking';
  const button = $('talkButton');
  button.classList.toggle('listening', state !== 'off');
  button.setAttribute('aria-pressed', state !== 'off' ? 'true' : 'false');
}
function talkAvailable() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  return Boolean(Recognition || (RT && RT.client && window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext));
}
function listenWithRecognition(Recognition) {
  return new Promise((resolve) => {
    const rec = new Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    let done = false;
    const finish = (value) => { if (done) return; done = true; talk.cancel = null; resolve(value); };
    talk.cancel = () => { try { rec.abort(); } catch { /* stopped */ } finish(''); };
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript + ' ';
        else interim += event.results[i][0].transcript;
      }
      setTalkState('hearing', (finalText + interim).trim());
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') { toast('Microphone access is blocked. Allow it in the browser to talk.', 'error'); stopTalk(); }
      finish(finalText.trim());
    };
    rec.onend = () => finish(finalText.trim());
    try { rec.start(); } catch { finish(''); }
  });
}
async function listenWithRecorder() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone access is blocked. Allow it to talk.', 'error'); stopTalk(); return ''; }
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start(250);
  const detector = turnDetector({ start: performance.now() });
  let outcome = 'listening';
  let cancelled = false;
  talk.cancel = () => { cancelled = true; };
  while (outcome === 'listening' && !cancelled && talk.on) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    analyser.getByteTimeDomainData(samples);
    outcome = detector.push(rmsLevel(samples), performance.now());
    if (detector.heard && talk.state === 'listening') setTalkState('hearing', '…');
  }
  talk.cancel = null;
  if (recorder.state !== 'inactive') recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  context.close().catch(() => {});
  if (cancelled || outcome !== 'done' || !chunks.length) return '';
  setTalkState('sending', '…');
  const mime = (recorder.mimeType || type || 'audio/webm').split(';')[0];
  try {
    const response = await fetch(RT.client.origin + '/api/transcribe', { method: 'POST', headers: { authorization: 'Bearer ' + RT.client.token, 'content-type': mime }, body: new Blob(chunks, { type: mime }), cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'error ' + response.status);
    return String(data.text || '').trim();
  } catch (error) { toast('Could not transcribe: ' + error.message, 'error'); return ''; }
}
function speakWithBrowser(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') { resolve(); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || 'en-US';
    utterance.rate = 1.05;
    let done = false;
    const finish = () => { if (done) return; done = true; talk.cancel = null; resolve(); };
    utterance.onend = finish;
    utterance.onerror = finish;
    talk.cancel = () => { window.speechSynthesis.cancel(); finish(); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}
async function speakReply(markdown) {
  const text = speakable(markdown);
  if (!text || !talk.on) return;
  setTalkState('speaking', text.split('\n')[0]);
  if (talk.speechApi) {
    try {
      const response = await fetch(RT.client.origin + '/api/speak', { method: 'POST', headers: { authorization: 'Bearer ' + RT.client.token, 'content-type': 'application/json' }, body: JSON.stringify({ text }), cache: 'no-store' });
      if (!response.ok) throw new Error('speech ' + response.status);
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      talk.audio = audio;
      await new Promise((resolve) => {
        const finish = () => { talk.cancel = null; resolve(); };
        audio.onended = finish; audio.onerror = finish;
        talk.cancel = () => { audio.pause(); finish(); };
        audio.play().catch(finish);
      });
      URL.revokeObjectURL(url);
      talk.audio = null;
      return;
    } catch { talk.speechApi = false; /* use the browser's voice from now on */ }
  }
  await speakWithBrowser(text);
}
async function talkLoop() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let quiet = 0;
  while (talk.on) {
    if (agent.busy) { setTalkState('working'); await turnSettled; continue; }
    setTalkState('listening');
    const heard = Recognition ? await listenWithRecognition(Recognition) : await listenWithRecorder();
    if (!talk.on) break;
    if (!heard) {
      // Browsers stop recognition after a few seconds of silence; keep listening, but
      // stop after about a minute of nothing so the microphone doesn't stay on forever.
      if (++quiet >= 12) { toast('Talk mode ended after a minute of silence.'); break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    quiet = 0;
    if (isStopPhrase(heard)) break;
    setTalkState('working', heard);
    await send(heard);
    if (!talk.on) break;
    await speakReply(lastReply(display) || 'Done.');
  }
  stopTalk();
}
async function startTalk() {
  if (talk.on) return;
  if (!modelReady()) { toast('Connect a model first, then talk with OASIS.'); return; }
  talk.on = true;
  if (dictation.listening) dictation.stop(true);
  if (talk.speechApi === null && RT && RT.client) {
    const voice = await RT.client.api('/api/voice').catch(() => null);
    if (voice && voice.disabledByPolicy) { talk.on = false; toast('Voice is turned off by your organization.', 'error'); return; }
    talk.speechApi = Boolean(voice && voice.speech);
  }
  talkLoop().catch((error) => { toast('Talk mode stopped: ' + (error && error.message || error), 'error'); stopTalk(); });
}
function stopTalk() {
  talk.on = false;
  if (talk.cancel) talk.cancel();
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  setTalkState('off');
}
function setupTalk() {
  const button = $('talkButton');
  if (!talkAvailable()) return;
  button.hidden = false;
  button.addEventListener('click', () => { if (talk.on) stopTalk(); else startTalk(); });
  $('talkEnd').addEventListener('click', stopTalk);
  $('talkSkip').addEventListener('click', () => { if (talk.state === 'speaking' && talk.cancel) talk.cancel(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && talk.on && $('approvalSheet').hidden) stopTalk(); });
}

// Opening a fresh OASIS link in a tab that is already open only changes the hash, so the
// page would keep using the old key (after a server restart every request then fails).
// Reload so the new key from the link is used.
window.addEventListener('hashchange', () => {
  if (/(?:^#|[#&?])token=[A-Za-z0-9_-]{16,200}/.test(location.hash)) location.reload();
});

async function boot() {
  follow.init();
  applyTheme();
  applySidebar();
  $('sideSearchKey').textContent = isApplePlatform ? '⌘K' : 'Ctrl K';
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
  setupTalk();
  setupUpdates();
  // The side panel comes back open only where it sits beside the chat; on a
  // phone it would cover the conversation.
  if (innerWidth >= 1024 && (localStorage.getItem('oasis.files') === '1' || (localStorage.getItem('oasis.files') === null && workspace))) toggleFiles(true);
  { const tab = localStorage.getItem('oasis.panelTab'); if (tab === 'activity' || tab === 'changes') showPanelTab(tab); }
  refreshFiles();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const shared = new URLSearchParams(location.search);
  if (shared.get('repo')) { $('repoInput').value = shared.get('repo'); openProjects(); }
  if (shared.get('q')) { $('input').value = shared.get('q'); autosize(); renderPluginSuggest(); }
  if (!modelReady() && !workspace) $('connectInput').focus({ preventScroll: true });
}
// data-ready tells automation (and tests) that boot finished on this page load.
boot().catch((error) => toast(error.message, 'error')).finally(() => { document.documentElement.dataset.ready = '1'; $('welcome').classList.remove('booting'); });

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
