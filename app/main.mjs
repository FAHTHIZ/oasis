// OASIS universal app: UI wiring. All agent work happens on this device.
import { PRESETS, testProvider } from './core/providers.mjs';
import { IndexedDBStore, Workspace, lineDiff } from './core/workspace.mjs';
import { Agent } from './core/agent.mjs';
import { FrameSandbox } from './core/sandbox.mjs';
import { SkillLibrary } from './core/skills.mjs';
import { GitHub, parseRepo } from './core/github.mjs';
import { createZip, readZip } from './core/zip.mjs';
import { renderMarkdown } from './markdown.mjs';

const APP_VERSION = '1.2.0';
const $ = (id) => document.getElementById(id);
const store = new IndexedDBStore();
const sandbox = new FrameSandbox();
const skills = new SkillLibrary({ baseURL: new URL('skills/', location.href).href });

const DEFAULTS = { provider: 'openrouter', baseURL: PRESETS.openrouter.baseURL, model: PRESETS.openrouter.model, apiKey: '', protocol: 'openai', mode: 'ask', maxSteps: 40, theme: 'system', githubToken: '' };
let settings = loadSettings();
let workspace = null;
let display = [];          // rendered history: [{ role, content, tools: [{id,name,args,ok,content}] }]
let currentTurn = null;    // DOM refs for the assistant reply being streamed
let allowEditsThisSession = false;
let deferredInstall = null;

/* ---------- Settings ---------- */
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('oasis.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() { localStorage.setItem('oasis.settings', JSON.stringify(settings)); }
function providerConfig() {
  return { protocol: settings.protocol, baseURL: settings.baseURL, apiKey: settings.apiKey, model: settings.model, mode: allowEditsThisSession && settings.mode === 'ask' ? 'edits' : settings.mode, provider: settings.provider };
}
function modelReady() { return Boolean(settings.model && (settings.apiKey || /localhost|127\.0\.0\.1/.test(settings.baseURL) || settings.provider === 'custom' && settings.baseURL)); }
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
  if (event.key === 'Escape') {
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
const agent = new Agent({
  getConfig: () => ({ ...providerConfig(), maxSteps: settings.maxSteps }),
  getContext: () => ({
    workspace,
    sandbox,
    skills,
    github: settings.githubToken ? new GitHub({ token: settings.githubToken }) : null,
    onChange: () => refreshFiles()
  }),
  approve: requestApproval,
  onEvent: handleEvent
});

async function ensureWorkspace() {
  if (workspace) return workspace;
  workspace = await Workspace.create(store, { name: 'Scratch project' });
  localStorage.setItem('oasis.project', workspace.project.id);
  skills.setWorkspace(workspace);
  updateProjectUI();
  return workspace;
}

async function send(text) {
  const message = text.trim();
  if (!message) return;
  if (!modelReady()) { openSettings(); toast('Connect a model first: choose a provider and paste a key.'); return; }
  await ensureWorkspace();
  $('input').value = '';
  autosize();
  setBusy(true);
  try { await agent.send(message, { maxSteps: Number(settings.maxSteps) || 40 }); }
  catch { /* shown through the error event */ }
  finally { setBusy(false); persistChat(); refreshFiles(); }
}

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  $('sendButton').setAttribute('aria-label', busy ? 'Stop' : 'Send');
}

function summarizeArgs(name, args = {}) {
  if (args.path) return args.path + (args.offset ? ':' + args.offset : '');
  if (args.pattern) return args.pattern + (args.path ? '  in ' + args.path : '');
  if (args.url) return args.url;
  if (args.name) return args.name;
  if (args.code) return String(args.code).split('\n')[0].slice(0, 80);
  if (args.branch) return args.branch;
  if (args.todos) return args.todos.length + ' items';
  return '';
}
const TOOL_LABELS = { list_files: 'List', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', delete_file: 'Delete', grep: 'Search', glob_files: 'Find', run_javascript: 'Run', fetch_url: 'Fetch', load_skill: 'Skill', todo_write: 'Plan', project_changes: 'Changes', github_push: 'Push' };

function toolCard(tool) {
  const el = document.createElement('details');
  el.className = 'tool ' + (tool.ok === undefined ? 'running' : tool.ok ? 'ok' : 'fail');
  el.dataset.id = tool.id;
  const summary = document.createElement('summary');
  summary.innerHTML = '<span class="state"></span><span class="name"></span><span class="arg"></span>';
  summary.querySelector('.name').textContent = TOOL_LABELS[tool.name] || tool.name;
  summary.querySelector('.arg').textContent = summarizeArgs(tool.name, tool.args);
  const pre = document.createElement('pre');
  pre.textContent = tool.content || 'Running…';
  el.append(summary, pre);
  return el;
}

function addMessage(role, content) {
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
  $('transcript').appendChild(wrap);
  $('welcome').hidden = true;
  return wrap;
}

function scrollDown(force = false) {
  const chat = $('chat');
  if (force || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 220) chat.scrollTop = chat.scrollHeight;
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!currentTurn) return;
    currentTurn.body.innerHTML = renderMarkdown(currentTurn.text);
    currentTurn.body.classList.add('cursor');
    scrollDown();
  });
}

function startTurn() {
  const wrap = addMessage('assistant', '');
  const body = wrap.querySelector('.body');
  const tools = document.createElement('div');
  tools.className = 'tools';
  wrap.appendChild(tools);
  currentTurn = { wrap, body, tools, text: '', entry: { role: 'assistant', content: '', tools: [] } };
  display.push(currentTurn.entry);
}

function removeThinking() { const t = document.querySelector('.thinking'); if (t) t.remove(); }

function handleEvent(event) {
  switch (event.type) {
    case 'user':
      display.push({ role: 'user', content: event.content });
      addMessage('user', event.content);
      scrollDown(true);
      break;
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
      toast('Provider busy, retrying (' + event.attempt + ')…');
      break;
    case 'assistant': {
      removeThinking();
      if (!currentTurn) startTurn();
      currentTurn.text = event.content || '';
      currentTurn.entry.content = currentTurn.text;
      currentTurn.body.classList.remove('cursor');
      currentTurn.body.innerHTML = renderMarkdown(currentTurn.text);
      currentTurn.body.hidden = !currentTurn.text;
      if (!currentTurn.text && !event.toolCalls.length) currentTurn.wrap.remove();
      break;
    }
    case 'tool_start': {
      const tool = { id: event.id, name: event.name, args: event.args };
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
      tool.content = event.content.length > 6000 ? event.content.slice(0, 6000) + '\n…' : event.content;
      const card = currentTurn.tools.querySelector('[data-id="' + CSS.escape(event.id) + '"]');
      if (card) card.replaceWith(toolCard(tool));
      break;
    }
    case 'todos': renderTodos(event.todos); break;
    case 'usage': $('usage').textContent = formatTokens(event.usage.input + event.usage.output) + ' tok'; break;
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
      currentTurn = null;
      break;
    default: break;
  }
}

function formatTokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }

function renderTodos(todos) {
  const box = $('todos');
  box.replaceChildren();
  box.hidden = !todos.length || todos.every((t) => t.status === 'completed');
  for (const todo of todos) {
    const row = document.createElement('div');
    row.className = todo.status;
    row.textContent = (todo.status === 'completed' ? '✓ ' : todo.status === 'in_progress' ? '› ' : '○ ') + todo.content;
    box.appendChild(row);
  }
}

async function persistChat() {
  if (!workspace) return;
  const trimmed = display.slice(-200).map((entry) => ({ ...entry, tools: entry.tools && entry.tools.map((t) => ({ ...t, content: (t.content || '').slice(0, 2000) })) }));
  try { await store.setValue('chat:' + workspace.project.id, { messages: agent.messages.slice(-300), display: trimmed }); } catch { /* storage full: chat stays in memory */ }
}

async function restoreChat() {
  $('transcript').replaceChildren();
  display = [];
  agent.reset();
  renderTodos([]);
  $('usage').textContent = '';
  if (!workspace) { $('welcome').hidden = false; return; }
  const saved = await store.getValue('chat:' + workspace.project.id);
  if (saved && saved.display && saved.display.length) {
    agent.load(saved.messages);
    display = saved.display;
    for (const entry of display) {
      const el = addMessage(entry.role, entry.content);
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
async function requestApproval({ name, args }) {
  const summary = $('approvalSummary');
  const detail = $('approvalDetail');
  detail.replaceChildren();
  detail.hidden = false;
  $('allowAllButton').hidden = !['write_file', 'edit_file'].includes(name) || settings.mode !== 'ask';
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
$('allowAllButton').addEventListener('click', () => { allowEditsThisSession = true; updateModeUI(); answerApproval(true); });

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
$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer:fine)').matches) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (agent.busy) { agent.stop(); return; }
  send($('input').value);
});

function updateModeUI() {
  const mode = providerConfig().mode;
  $('modeChip').dataset.mode = mode;
  $('modeLabel').textContent = mode === 'auto' ? 'Full auto' : mode === 'edits' ? 'Auto edit' : 'Ask first';
  for (const button of $('modeMenu').querySelectorAll('button')) button.setAttribute('aria-checked', String(button.dataset.mode === mode));
  $('modelChip').textContent = settings.model ? settings.model.split('/').pop() : '';
}
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
document.addEventListener('click', (event) => { if (!event.target.closest('#modeMenu')) $('modeMenu').hidden = true; });

/* ---------- Welcome ---------- */
const SUGGESTIONS = [
  'Explain how this project is organised',
  'Find and fix a bug, then prove the fix with a test',
  'Write tests for the main module and run them',
  'Build a small to-do web app in index.html'
];
function renderWelcome() {
  const steps = $('setupSteps');
  steps.replaceChildren();
  const items = [
    { done: modelReady(), title: 'Connect a model', sub: modelReady() ? PRESETS[settings.provider]?.label + ' · ' + settings.model : 'Any provider: OpenRouter, Anthropic, OpenAI, Gemini, Ollama and more', action: openSettings },
    { done: Boolean(workspace), title: 'Open a project', sub: workspace ? workspace.project.name : 'From GitHub, a folder, a zip, or start empty', action: () => openProjects() },
    { done: false, title: 'Ask OASIS', sub: 'It reads, edits and tests the code right on this device', action: () => $('input').focus() }
  ];
  items.forEach((item, index) => {
    const button = document.createElement('button');
    button.className = 'step' + (item.done ? ' done' : '');
    button.innerHTML = '<span class="num"></span><span><strong></strong><span class="sub"></span></span>';
    button.querySelector('.num').textContent = item.done ? '✓' : String(index + 1);
    button.querySelector('strong').textContent = item.title;
    button.querySelector('.sub').textContent = item.sub;
    button.addEventListener('click', item.action);
    steps.appendChild(button);
  });
  const box = $('suggestions');
  box.replaceChildren();
  if (modelReady()) for (const text of SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.className = 'suggestion';
    chip.textContent = text;
    chip.addEventListener('click', () => { $('input').value = text; autosize(); $('input').focus(); });
    box.appendChild(chip);
  }
}

/* ---------- Settings sheet ---------- */
function fillProviderOptions() {
  const select = $('providerSelect');
  select.replaceChildren(...Object.entries(PRESETS).map(([id, preset]) => new Option(preset.label, id)));
}
function openSettings() {
  $('providerSelect').value = settings.provider;
  $('baseUrlInput').value = settings.baseURL;
  $('modelInput').value = settings.model;
  $('keyInput').value = settings.apiKey;
  $('keyInput').placeholder = PRESETS[settings.provider]?.keyHint || '';
  $('providerNote').textContent = PRESETS[settings.provider]?.note || '';
  $('modeSelect').value = settings.mode;
  $('maxStepsInput').value = settings.maxSteps;
  $('themeSelect').value = settings.theme;
  $('githubToken').value = settings.githubToken;
  $('testResult').textContent = '';
  $('versionLabel').textContent = APP_VERSION;
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
function formSettings() {
  const provider = $('providerSelect').value;
  return {
    ...settings,
    provider,
    protocol: PRESETS[provider].protocol,
    baseURL: $('baseUrlInput').value.trim(),
    model: $('modelInput').value.trim(),
    apiKey: $('keyInput').value.trim(),
    mode: $('modeSelect').value,
    maxSteps: Math.min(200, Math.max(5, Number($('maxStepsInput').value) || 40)),
    theme: $('themeSelect').value,
    githubToken: $('githubToken').value.trim()
  };
}
$('testButton').addEventListener('click', async () => {
  const draft = formSettings();
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
  saveSettings();
  applyTheme();
  updateModeUI();
  updateProjectUI();
  renderWelcome();
  closeSheet('settingsSheet');
  toast('Settings saved on this device.');
});
$('clearChat').addEventListener('click', async () => {
  if (agent.busy) agent.stop();
  agent.reset();
  display = [];
  if (workspace) await store.setValue('chat:' + workspace.project.id, null);
  await restoreChat();
  renderWelcome();
  closeSheet('settingsSheet');
});
$('wipeAll').addEventListener('click', async () => {
  if (!confirm('Erase all projects, chats, keys and settings stored by OASIS on this device?')) return;
  localStorage.clear();
  await new Promise((resolve) => { const req = indexedDB.deleteDatabase('oasis-universal'); req.onsuccess = req.onerror = req.onblocked = resolve; });
  if ('caches' in window) for (const key of await caches.keys()) await caches.delete(key);
  location.reload();
});

/* ---------- Projects ---------- */
async function openProjects() {
  const list = $('projectList');
  list.replaceChildren();
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
      await store.setValue('chat:' + project.id, null);
      if (workspace && workspace.project.id === project.id) { workspace = null; localStorage.removeItem('oasis.project'); await restoreChat(); updateProjectUI(); refreshFiles(); }
      openProjects();
    });
    li.append(open, del);
    list.appendChild(li);
  }
  if ($('projectsSheet').hidden) openSheet('projectsSheet');
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
  $('projectName').textContent = workspace ? workspace.project.name : 'No project';
  const github = workspace && workspace.project.source && workspace.project.source.type === 'github';
  $('pushButton').hidden = !github;
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
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) { other.classList.toggle('active', other === tab); other.setAttribute('aria-selected', String(other === tab)); }
    $('fileList').hidden = tab.dataset.tab !== 'files';
    $('changesList').hidden = tab.dataset.tab !== 'changes';
    $('fileFilter').parentElement.hidden = tab.dataset.tab !== 'files';
  });
}
$('fileFilter').addEventListener('input', () => refreshFiles());

let refreshQueued = false;
function refreshFiles() {
  if (refreshQueued) return;
  refreshQueued = true;
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
    const frag = document.createDocumentFragment();
    for (const path of paths.slice(0, 3000)) frag.appendChild(fileRow(path, status.get(path)));
    list.appendChild(frag);
    const changesList = $('changesList');
    changesList.replaceChildren();
    if (!changes.length) changesList.innerHTML = '<p class="empty">No changes since this project was opened.</p>';
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
  const files = await workspace.load();
  const file = files.get(path);
  $('editorTitle').textContent = path;
  $('editor').value = file && !file.deleted ? file.content : '';
  $('editor').readOnly = Boolean(file && file.deleted);
  $('diffToggle').hidden = !status;
  $('revertButton').hidden = !status;
  $('deleteFileButton').hidden = Boolean(file && file.deleted);
  $('saveFileButton').hidden = Boolean(file && file.deleted);
  $('diffView').hidden = true;
  $('editor').hidden = false;
  $('diffToggle').textContent = 'Diff';
  if (status === 'deleted') showDiff();
  openSheet('editorSheet');
}
async function showDiff() {
  const file = (await workspace.load()).get(editingPath);
  renderDiff($('diffView'), lineDiff(file.original || '', file.deleted ? '' : $('editor').value));
  $('diffView').hidden = false;
  $('editor').hidden = true;
  $('diffToggle').textContent = 'Edit';
}
$('diffToggle').addEventListener('click', () => { if ($('diffView').hidden) showDiff(); else { $('diffView').hidden = true; $('editor').hidden = false; $('diffToggle').textContent = 'Diff'; } });
$('saveFileButton').addEventListener('click', async () => { await workspace.write(editingPath, $('editor').value); refreshFiles(); toast('Saved ' + editingPath); closeSheet('editorSheet'); });
$('revertButton').addEventListener('click', async () => { if (!confirm('Revert ' + editingPath + ' to how it was when opened?')) return; await workspace.revert(editingPath); refreshFiles(); closeSheet('editorSheet'); toast('Reverted ' + editingPath); });
$('deleteFileButton').addEventListener('click', async () => { if (!confirm('Delete ' + editingPath + '?')) return; await workspace.remove(editingPath); refreshFiles(); closeSheet('editorSheet'); });
$('editor').addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); document.execCommand('insertText', false, '  '); }
  if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); $('saveFileButton').click(); }
});
$('newFileButton').addEventListener('click', async () => {
  await ensureWorkspace();
  const path = prompt('New file path', 'src/index.js');
  if (!path) return;
  try { if (!(await workspace.exists(path))) await workspace.write(path, ''); refreshFiles(); openEditor(path.replace(/^\.?\/+/, ''), 'added'); }
  catch (error) { toast(error.message, 'error'); }
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

/* ---------- Install ---------- */
addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstall = event; $('installButton').hidden = false; });
addEventListener('appinstalled', () => { $('installButton').hidden = true; deferredInstall = null; toast('OASIS installed.'); });
$('installButton').addEventListener('click', async () => {
  if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installButton').hidden = true; return; }
  toast('On iPhone or iPad: tap Share, then Add to Home Screen.');
});
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) $('installButton').hidden = false;

/* ---------- Boot ---------- */
async function boot() {
  applyTheme();
  fillProviderOptions();
  updateModeUI();
  const id = localStorage.getItem('oasis.project');
  if (id && (await store.getProject(id))) await switchProject(id);
  else { await restoreChat(); updateProjectUI(); }
  renderWelcome();
  if (localStorage.getItem('oasis.files') === '1' || (localStorage.getItem('oasis.files') === null && innerWidth >= 1024 && workspace)) toggleFiles(true);
  refreshFiles();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const shared = new URLSearchParams(location.search);
  if (shared.get('repo')) { $('repoInput').value = shared.get('repo'); openProjects(); }
  if (shared.get('q')) { $('input').value = shared.get('q'); autosize(); }
}
boot().catch((error) => toast(error.message, 'error'));
