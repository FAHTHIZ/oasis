// The OASIS chat panel: a webview (sidebar view or editor tab) backed by `oasis -p` in
// stream-json mode. Edits open as native diffs (Accept/Reject); other approvals show inline.
'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { OasisChatProcess } = require('./chat-process.js');

class ChatController {
  constructor({ getCommand, getCwd, getEnv }) {
    this.getCommand = getCommand;
    this.getCwd = getCwd;
    this.getEnv = getEnv;
    this.webviews = new Set();
    this.history = [];
    this.process = null;
  }

  ensureProcess() {
    if (this.process) return this.process;
    const proc = new OasisChatProcess({ command: this.getCommand(), cwd: this.getCwd(), env: this.getEnv() });
    proc.on('ui', (message) => {
      this.history.push(message);
      if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
      this.post(message);
      if (message.kind === 'exit' || message.kind === 'error') { if (this.process === proc) this.process = null; }
    });
    let stderrTail = '';
    proc.on('stderr', (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000); });
    proc.on('ui', (message) => { if (message.kind === 'exit' && message.code && stderrTail.trim()) this.post({ kind: 'error', text: stderrTail.trim().split('\n').slice(-6).join('\n') }); });
    this.process = proc;
    proc.start();
    return proc;
  }

  post(message) { for (const webview of this.webviews) webview.postMessage(message); }

  attach(webview) {
    this.webviews.add(webview);
    webview.options = { enableScripts: true };
    webview.html = chatHtml(webview);
    const sub = webview.onDidReceiveMessage((message) => this.onMessage(message, webview));
    return { dispose: () => { this.webviews.delete(webview); sub.dispose(); } };
  }

  onMessage(message, webview = null) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') { if (webview) webview.postMessage({ kind: 'replay', items: this.history }); return; }
    if (message.type === 'send') {
      const text = String(message.text || '').trim();
      if (!text) return;
      const user = { kind: 'user', text };
      this.history.push(user);
      this.post(user);
      this.ensureProcess().send(text);
      return;
    }
    if (message.type === 'permission' && this.process) { this.process.respond(message.requestId, message.behavior === 'allow' ? 'allow' : 'deny', { always: Boolean(message.always) }); return; }
    if (message.type === 'interrupt' && this.process) { this.process.interrupt(); return; }
    if (message.type === 'newChat') { this.reset(); return; }
  }

  reset() {
    if (this.process) this.process.stop();
    this.process = null;
    this.history = [];
    this.post({ kind: 'reset' });
  }

  insert(text) { this.post({ kind: 'insert', text }); }

  dispose() { if (this.process) this.process.stop(); this.process = null; }
}

class ChatViewProvider {
  constructor(controller) { this.controller = controller; this.view = null; }
  resolveWebviewView(view) {
    this.view = view;
    const handle = this.controller.attach(view.webview);
    view.onDidDispose(() => handle.dispose());
  }
}

function openChatPanel(controller) {
  const panel = vscode.window.createWebviewPanel('oasis.chatPanel', 'OASIS', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  const handle = controller.attach(panel.webview);
  panel.onDidDispose(() => handle.dispose());
  return panel;
}

function chatHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "';";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 8px 10px; }
  .msg { margin: 8px 0; line-height: 1.45; white-space: normal; word-wrap: break-word; }
  .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; }
  .assistant p { margin: 4px 0; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 0.9em; color: var(--vscode-descriptionForeground); border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 6px; }
  .tool.err { border-left-color: var(--vscode-errorForeground); }
  .note { color: var(--vscode-descriptionForeground); font-size: 0.9em; font-style: normal; }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; border-radius: 4px; overflow-x: auto; }
  code { font-family: var(--vscode-editor-font-family); }
  .perm { border: 1px solid var(--vscode-focusBorder); border-left: 4px solid var(--vscode-editorWarning-foreground, var(--vscode-focusBorder)); border-radius: 6px; padding: 8px; }
  .perm.perm-risk { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  .perm .perm-warning { color: var(--vscode-errorForeground); font-weight: 700; margin-top: 6px; }
  .perm .perm-guidance { color: var(--vscode-descriptionForeground); margin: 8px 0; }
  .perm pre { max-height: 160px; }
  .perm .done { color: var(--vscode-descriptionForeground); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; margin-right: 6px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #bar { border-top: 1px solid var(--vscode-panel-border); padding: 8px; }
  #input { width: 100%; box-sizing: border-box; min-height: 56px; max-height: 240px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 6px; font-family: inherit; font-size: inherit; }
  #row { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
  #status { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  #empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; }
</style></head>
<body>
<div id="log"><div id="empty">Ask OASIS to read, change or explain code in this workspace. Your editor selection is shared with each message. Edits open as diffs for you to accept or reject.</div></div>
<div id="bar">
  <textarea id="input" placeholder="Message OASIS (Enter to send, Shift+Enter for a new line)"></textarea>
  <div id="row"><span id="status">Ready</span><span><button id="stop" class="secondary" hidden>Stop</button><button id="new" class="secondary">New chat</button><button id="send">Send</button></span></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('input');
const statusEl = document.getElementById('status');
const stopBtn = document.getElementById('stop');
let live = null; let liveText = '';
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function md(text) {
  const parts = String(text).split(/\`\`\`/);
  return parts.map((part, i) => {
    if (i % 2) { const nl = part.indexOf('\\n'); return '<pre><code>' + esc(nl >= 0 ? part.slice(nl + 1) : part) + '</code></pre>'; }
    return esc(part).replace(/\`([^\`]+)\`/g, '<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').split(/\\n{2,}/).map((p) => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');
  }).join('');
}
function add(cls, html) { const empty = document.getElementById('empty'); if (empty) empty.remove(); const div = document.createElement('div'); div.className = 'msg ' + cls; div.innerHTML = html; log.appendChild(div); log.scrollTop = log.scrollHeight; return div; }
function endLive() { live = null; liveText = ''; }
function render(m) {
  switch (m.kind) {
    case 'user': endLive(); add('user', esc(m.text)); break;
    case 'delta': if (!live) { live = add('assistant', ''); liveText = ''; } liveText += m.text; live.innerHTML = md(liveText); log.scrollTop = log.scrollHeight; break;
    case 'assistant': if (live) { live.innerHTML = md(m.text || liveText); endLive(); } else if (m.text) add('assistant', md(m.text)); break;
    case 'tool': endLive(); add('tool', '▸ ' + esc(m.summary) + (m.subagent ? ' <span class="note">(' + esc(m.subagent) + ')</span>' : '')); break;
    case 'toolResult': if (m.isError) add('tool err', '✗ ' + esc(m.name) + ': ' + esc(m.preview.slice(0, 300))); break;
    case 'note': add('note', esc(m.text)); break;
    case 'error': endLive(); add('error', esc(m.text)); break;
    case 'init': statusEl.textContent = (m.model || 'OASIS') + ' · ' + (m.permissionMode || 'default'); break;
    case 'permission': {
      endLive();
      const requestText = String(m.message || 'No action details were supplied.');
      const mayDestroyData = /\\brm\\s+-[a-z]*r\\b|\\b(delete|remove|overwrite|format|truncate)\\b|\\bdrop\\s+table\\b/i.test(requestText);
      const promptClass = mayDestroyData ? 'perm perm-risk' : 'perm';
      const warning = mayDestroyData ? '<div class="perm-warning">Caution: this request may remove or overwrite data.</div>' : '';
      const div = add(promptClass,
        '<div><strong>OASIS needs permission to continue</strong>' + (m.tool ? ' · ' + esc(m.tool) : '') + '</div>' +
        warning +
        '<p class="perm-guidance">Review the requested action and its target below. If anything is unclear, choose Deny.</p>' +
        '<pre>' + esc(requestText.slice(0, 4000)) + '</pre>' +
        '<div class="actions"><button data-b="allow">Allow once</button>' +
        (m.canAlways ? '<button data-b="always" class="secondary">Always allow ' + esc(m.suggestion || 'this suggested action') + '</button>' : '') +
        '<button data-b="deny" class="secondary">Deny</button></div>');
      div.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
        const b = btn.getAttribute('data-b');
        vscode.postMessage({ type: 'permission', requestId: m.requestId, behavior: b === 'deny' ? 'deny' : 'allow', always: b === 'always' });
        div.querySelector('.actions').innerHTML = '<span class="done">' + (b === 'deny' ? 'Denied' : b === 'always' ? 'Saved the allow rule' : 'Allowed once') + '</span>';
      }));
      break;
    }
    case 'turnEnd': endLive(); if (m.isError && m.text) add('error', esc(m.text)); break;
    case 'busy': stopBtn.hidden = !m.busy; if (!m.busy && statusEl.textContent === 'Working…') statusEl.textContent = 'Ready'; if (m.busy) statusEl.textContent = 'Working…'; break;
    case 'exit': endLive(); stopBtn.hidden = true; if (m.code) add('error', 'OASIS exited with code ' + m.code + '.'); break;
    case 'reset': log.innerHTML = ''; endLive(); statusEl.textContent = 'Ready'; stopBtn.hidden = true; break;
    case 'insert': input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + m.text; input.focus(); break;
    case 'replay': for (const item of m.items || []) render(item); break;
  }
}
window.addEventListener('message', (event) => render(event.data));
function send() { const text = input.value.trim(); if (!text) return; vscode.postMessage({ type: 'send', text }); input.value = ''; }
document.getElementById('send').addEventListener('click', send);
document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } if (e.key === 'Escape') vscode.postMessage({ type: 'interrupt' }); });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

module.exports = { ChatController, ChatViewProvider, openChatPanel, chatHtml };
