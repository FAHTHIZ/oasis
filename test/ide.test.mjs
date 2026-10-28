import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { discoverIde, attachIde, ideSelectionContext, reviewEditInIde, runIdeTool, packageExtension, proposedContent, IdeClient } from '../src/ide.mjs';

const require = createRequire(import.meta.url);
const { startIdeServer } = require('../ide/vscode/src/server.js');

async function setup(t, overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-ide-'));
  const root = path.join(base, 'project');
  await (await import('node:fs/promises')).mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'app.js'), 'const a = 1;\nconst b = 2;\n');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg'), OASIS_IDE_PORT: '', OASIS_IDE: '' };
  const calls = [];
  const adapter = {
    ideName: 'Test Code',
    workspaceFolders: () => [root],
    async getSelection() { calls.push('getSelection'); return { filePath: path.join(root, 'app.js'), relativePath: 'app.js', languageId: 'javascript', text: 'const b = 2;', isEmpty: false, startLine: 2, endLine: 2 }; },
    async getOpenEditors() { return { editors: [] }; },
    async getWorkspaceFolders() { return { folders: [root] }; },
    async getDiagnostics(params) { calls.push(['getDiagnostics', params.path]); return { files: [{ filePath: path.join(root, 'app.js'), relativePath: 'app.js', diagnostics: [{ severity: 'error', message: 'b is unused', line: 2, column: 7 }] }] }; },
    async openFile(params) { calls.push(['openFile', params.path, params.line]); return { opened: true }; },
    async openDiff(params) { calls.push(['openDiff', params.path, params.newContent]); return { decision: overrides.decision || 'accept' }; },
    async closeDiffs() { return { closed: true }; },
    ...overrides.adapter
  };
  const bridge = await startIdeServer(adapter, { env });
  t.after(async () => { await bridge.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, env, bridge, calls };
}

test('the CLI discovers the IDE bridge for its workspace and shares the selection', async (t) => {
  const { root, env, bridge, calls } = await setup(t);
  const lock = JSON.parse(await readFile(bridge.lockFile, 'utf8'));
  assert.equal(lock.port, bridge.port);
  assert.deepEqual(lock.workspaceFolders, [root]);
  const client = await discoverIde(path.join(root, 'sub', 'dir'), env);
  assert.ok(client, 'found by workspace folder');
  assert.equal(client.ideName, 'Test Code');
  assert.equal(await discoverIde(os.tmpdir(), env), null, 'other folders do not connect');
  assert.ok(await discoverIde(os.tmpdir(), { ...env, OASIS_IDE_PORT: String(bridge.port) }), 'OASIS_IDE_PORT wins');
  assert.equal(await discoverIde(root, { ...env, OASIS_IDE: 'off' }), null);

  const session = { root, messages: [{ role: 'system', content: 'sys' }], toolDefinitions: [] };
  attachIde(session, client);
  assert.deepEqual(session.toolDefinitions.map((tool) => tool.function.name), ['ide_get_diagnostics', 'ide_open_file']);
  assert.match(session.messages[0].content, /IDE: connected to Test Code/);
  const selection = await ideSelectionContext(session);
  assert.equal(selection.label, 'Selected 1 line from app.js');
  assert.match(selection.text, /<ide_selection>The user selected lines 2-2 of app\.js:\n```javascript\nconst b = 2;/);
  assert.ok(calls.includes('getSelection'));
});

test('edit approvals open as IDE diffs and the IDE decision is returned', async (t) => {
  const { root, env, calls } = await setup(t);
  const session = { root, messages: [], toolDefinitions: [] };
  attachIde(session, await discoverIde(root, env));
  assert.equal(await reviewEditInIde(session, { tool: 'edit_file', input: { path: 'app.js', old_string: 'const b = 2;', new_string: 'const b = 3;' } }), true);
  const diff = calls.find((call) => call[0] === 'openDiff');
  assert.equal(diff[1], path.join(root, 'app.js'));
  assert.equal(diff[2], 'const a = 1;\nconst b = 3;\n');
  assert.equal(await reviewEditInIde(session, { tool: 'edit_file', input: { path: 'app.js', old_string: 'missing', new_string: 'x' } }), null, 'unmatched edits fall back to the terminal');
  assert.equal(await reviewEditInIde(session, { tool: 'run_command', input: {} }), null);
  const multi = await proposedContent(root, 'multi_edit', { path: 'app.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'b = 2', new_string: 'b = 20' }] });
  assert.equal(multi.content, 'const a = 10;\nconst b = 20;\n');
});

test('a rejected diff denies the edit; diagnostics and open-file tools reach the IDE', async (t) => {
  const { root, env, calls } = await setup(t, { decision: 'reject' });
  const session = { root, messages: [], toolDefinitions: [] };
  attachIde(session, await discoverIde(root, env));
  assert.equal(await reviewEditInIde(session, { tool: 'write_file', input: { path: 'new.js', content: 'x' } }), false);
  const diagnostics = await runIdeTool(session, 'ide_get_diagnostics', { path: 'app.js' });
  assert.equal(diagnostics.total, 1);
  assert.deepEqual(calls.find((call) => call[0] === 'getDiagnostics'), ['getDiagnostics', path.join(root, 'app.js')]);
  await runIdeTool(session, 'ide_open_file', { path: 'app.js', line: 2 });
  assert.deepEqual(calls.find((call) => call[0] === 'openFile'), ['openFile', path.join(root, 'app.js'), 2]);
});

test('the bridge rejects missing tokens and browser origins', async (t) => {
  const { bridge } = await setup(t);
  const url = 'http://127.0.0.1:' + bridge.port + '/rpc';
  const body = JSON.stringify({ method: 'getSelection' });
  assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { authorization: 'Bearer ' + bridge.token, origin: 'https://evil.example' } })).status, 403);
  const client = new IdeClient({ port: bridge.port, authToken: bridge.token });
  await assert.rejects(client.call('deleteEverything'), /unknown method/);
});

test('oasis ide package builds a valid VSIX', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-vsix-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = await packageExtension(path.join(base, 'oasis.vsix'));
  const data = await readFile(result.file);
  assert.equal(data.readUInt32LE(0), 0x04034b50);
  const unzip = spawnSync('unzip', ['-l', result.file], { encoding: 'utf8' });
  if (unzip.status === null || unzip.error) return; // unzip not installed
  assert.equal(unzip.status, 0, unzip.stderr);
  for (const name of ['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/src/extension.js', 'extension/src/server.js']) assert.match(unzip.stdout, new RegExp(name.replace(/[.[\]]/g, '\\$&')));
  assert.equal(spawnSync('unzip', ['-tq', result.file]).status, 0);
});

test('the VS Code extension activates, starts the bridge, and serves the diff/selection adapter', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-ext-'));
  const previous = process.env.OASIS_CONFIG_DIR;
  process.env.OASIS_CONFIG_DIR = path.join(base, 'cfg');
  const Module = require('node:module');
  const commands = new Map(); const env = new Map(); const executed = [];
  const disposable = { dispose() {} };
  const uri = (fsPath, scheme = 'file', query = '') => ({ fsPath, path: fsPath, scheme, query });
  const document = { uri: uri(path.join(base, 'a.js')), languageId: 'javascript', getText: () => 'let x;', lineCount: 3 };
  const views = [];
  const vscode = {
    env: { appName: 'Visual Studio Code', clipboard: { writeText: async () => {} } },
    workspace: { workspaceFolders: [{ uri: uri(base) }], registerTextDocumentContentProvider: () => disposable, onDidChangeWorkspaceFolders: () => disposable, getConfiguration: () => ({ get: () => undefined }), fs: { stat: async () => ({}) }, openTextDocument: async () => document },
    window: {
      activeTextEditor: { document, selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } },
      onDidChangeTextEditorSelection: () => disposable, tabGroups: { all: [], close: async () => {} },
      showInformationMessage: async () => 'Accept', showWarningMessage: async () => {}, showTextDocument: async () => {}, terminals: [], createTerminal: () => ({ show() {}, sendText() {} }),
      registerWebviewViewProvider: (id) => { views.push(id); return disposable; }
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable; }, executeCommand: async (...args) => { executed.push(args[0]); } },
    languages: { getDiagnostics: () => [] },
    Uri: { file: (p) => uri(p), from: ({ scheme, path: p, query }) => uri(p, scheme, query) },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } }, Range: class { constructor(a, b) { this.start = a; this.end = b; } }, ViewColumn: { Beside: 2 }
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest); };
  const extension = require('../ide/vscode/src/extension.js');
  const context = { subscriptions: [], environmentVariableCollection: { replace: (key, value) => env.set(key, value) } };
  t.after(async () => { Module._load = originalLoad; await extension.deactivate(); if (previous === undefined) delete process.env.OASIS_CONFIG_DIR; else process.env.OASIS_CONFIG_DIR = previous; await rm(base, { recursive: true, force: true }); });
  await extension.activate(context);
  assert.ok(env.get('OASIS_IDE_PORT'), 'terminals receive OASIS_IDE_PORT');
  assert.deepEqual([...commands.keys()].sort(), ['oasis.addSelectionToChat', 'oasis.continueSession', 'oasis.focusChat', 'oasis.insertReference', 'oasis.newChat', 'oasis.openChat', 'oasis.openTerminal', 'oasis.rejectAllDiffs']);
  assert.deepEqual(views, ['oasis.chat']);
  const client = await discoverIde(base, { ...process.env, OASIS_IDE_PORT: env.get('OASIS_IDE_PORT') });
  assert.equal(client.ideName, 'Visual Studio Code');
  const selection = await client.call('getSelection');
  assert.equal(selection.text, 'let x;');
  assert.equal(selection.relativePath, 'a.js');
  assert.deepEqual(await client.call('openDiff', { path: path.join(base, 'a.js'), newContent: 'let y;' }), { decision: 'accept' });
  assert.ok(executed.includes('vscode.diff'));
});
