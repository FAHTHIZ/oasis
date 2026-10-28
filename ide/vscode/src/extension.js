// OASIS for VS Code (and VS Code forks such as Cursor and Windsurf).
//
// - Starts a local, token-authenticated bridge the OASIS CLI connects to automatically
//   when run from an integrated terminal (OASIS_IDE_PORT is set for every terminal).
// - Shares the active selection / open file with the agent as context.
// - Shows proposed edits in VS Code's native diff view: Accept or Reject there.
// - Gives the agent the editor's diagnostics (ide_get_diagnostics).
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { startIdeServer } = require('./server.js');

const PROPOSED_SCHEME = 'oasis-proposed';
const proposed = new Map();
let bridge = null;
let lastSelection = null;

function workspaceFolders() { return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath); }

function resolvePath(file) {
  if (!file) return null;
  if (path.isAbsolute(file)) return file;
  const root = workspaceFolders()[0];
  return root ? path.join(root, file) : file;
}

function relative(file) {
  const root = workspaceFolders().find((folder) => file.startsWith(folder + path.sep));
  return root ? path.relative(root, file).split(path.sep).join('/') : file;
}

function selectionPayload(editor) {
  if (!editor || editor.document.uri.scheme !== 'file') return null;
  const selection = editor.selection;
  const text = selection && !selection.isEmpty ? editor.document.getText(selection) : '';
  return {
    filePath: editor.document.uri.fsPath,
    relativePath: relative(editor.document.uri.fsPath),
    languageId: editor.document.languageId,
    text: text.slice(0, 100000),
    isEmpty: !text,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1 - (selection.end.character === 0 && selection.end.line > selection.start.line ? 1 : 0)
  };
}

const SEVERITY = ['error', 'warning', 'information', 'hint'];

const adapter = {
  ideName: vscode.env.appName || 'VS Code',
  workspaceFolders,
  async getSelection() {
    return selectionPayload(vscode.window.activeTextEditor) || lastSelection;
  },
  async getOpenEditors() {
    const tabs = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tab.input && tab.input.uri;
        if (uri && uri.scheme === 'file') tabs.push({ filePath: uri.fsPath, relativePath: relative(uri.fsPath), isActive: tab.isActive, isDirty: tab.isDirty });
      }
    }
    return { editors: tabs };
  },
  async getWorkspaceFolders() { return { folders: workspaceFolders() }; },
  async getDiagnostics(params) {
    const target = params.path ? vscode.Uri.file(resolvePath(params.path)) : null;
    const entries = target ? [[target, vscode.languages.getDiagnostics(target)]] : vscode.languages.getDiagnostics();
    const files = [];
    for (const [uri, list] of entries) {
      if (uri.scheme !== 'file' || !list.length) continue;
      files.push({ filePath: uri.fsPath, relativePath: relative(uri.fsPath), diagnostics: list.slice(0, 200).map((item) => ({
        severity: SEVERITY[item.severity] || 'error', message: item.message, source: item.source || '', code: typeof item.code === 'object' ? String(item.code.value) : item.code === undefined ? '' : String(item.code),
        line: item.range.start.line + 1, column: item.range.start.character + 1
      })) });
    }
    return { files: files.slice(0, 200) };
  },
  async openFile(params) {
    const uri = vscode.Uri.file(resolvePath(params.path));
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = Math.max(0, (Number(params.line) || 1) - 1);
    const position = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), preview: false });
    return { opened: true };
  },
  async openDiff(params) {
    const file = resolvePath(params.path);
    const key = Date.now().toString(36) + Math.random().toString(36).slice(2);
    proposed.set(key, String(params.newContent ?? ''));
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: file, query: key });
    let left = vscode.Uri.file(file);
    try { await vscode.workspace.fs.stat(left); } catch { left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: file, query: 'empty' }); proposed.set('empty', ''); }
    const title = (params.title || 'OASIS proposed change') + ': ' + relative(file) + ' ↔ proposed';
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
    const choice = await vscode.window.showInformationMessage('OASIS wants to ' + (params.action || 'edit') + ' ' + relative(file) + '.', { modal: false, detail: params.detail || '' }, 'Accept', 'Reject');
    await closeDiffTabs(key);
    proposed.delete(key);
    return { decision: choice === 'Accept' ? 'accept' : 'reject' };
  },
  async closeDiffs() { await closeDiffTabs(null); return { closed: true }; }
};

async function closeDiffTabs(key) {
  const tabs = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const modified = tab.input && tab.input.modified;
      if (modified && modified.scheme === PROPOSED_SCHEME && (!key || modified.query === key)) tabs.push(tab);
    }
  }
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

function oasisCommand() {
  return vscode.workspace.getConfiguration('oasis').get('command') || 'oasis';
}

function openTerminal(extraArgs = '') {
  const terminal = vscode.window.createTerminal({
    name: 'OASIS',
    cwd: workspaceFolders()[0],
    env: bridge ? { OASIS_IDE_PORT: String(bridge.port) } : {},
    location: vscode.workspace.getConfiguration('oasis').get('openInEditor') ? { viewColumn: vscode.ViewColumn.Beside } : undefined
  });
  terminal.show();
  terminal.sendText(oasisCommand() + (extraArgs ? ' ' + extraArgs : ''));
  return terminal;
}

function insertReference() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const info = selectionPayload(editor);
  const ref = '@' + info.relativePath + (info.isEmpty ? '' : '#L' + info.startLine + (info.endLine !== info.startLine ? '-' + info.endLine : ''));
  const terminal = vscode.window.terminals.find((item) => item.name === 'OASIS') || vscode.window.activeTerminal;
  if (terminal) { terminal.show(); terminal.sendText(ref + ' ', false); }
  else vscode.env.clipboard.writeText(ref).then(() => vscode.window.showInformationMessage('Copied ' + ref));
}

async function activate(context) {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
    provideTextDocumentContent: (uri) => proposed.get(uri.query) ?? ''
  }));
  try {
    bridge = await startIdeServer(adapter);
    context.environmentVariableCollection.replace('OASIS_IDE_PORT', String(bridge.port));
    context.subscriptions.push({ dispose: () => bridge && bridge.close() });
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => bridge && bridge.refreshLock()));
  } catch (error) {
    vscode.window.showWarningMessage('OASIS IDE bridge did not start: ' + error.message);
  }
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    const payload = selectionPayload(event.textEditor);
    if (payload) lastSelection = payload;
  }));
  context.subscriptions.push(
    vscode.commands.registerCommand('oasis.openTerminal', () => openTerminal()),
    vscode.commands.registerCommand('oasis.continueSession', () => openTerminal('--continue')),
    vscode.commands.registerCommand('oasis.insertReference', insertReference),
    vscode.commands.registerCommand('oasis.rejectAllDiffs', () => adapter.closeDiffs())
  );
}

async function deactivate() { if (bridge) await bridge.close(); bridge = null; }

module.exports = { activate, deactivate, _adapter: adapter };
