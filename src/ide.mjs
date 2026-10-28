// IDE integration (VS Code and forks), modeled on Claude Code's IDE bridge.
//
// The OASIS VS Code extension (ide/vscode) runs a token-authenticated RPC server on
// 127.0.0.1 and writes <config dir>/ide/<port>.lock. The CLI connects automatically
// when started from a VS Code integrated terminal (OASIS_IDE_PORT is set) or with
// /ide, then:
//   - adds the editor selection / active file to each prompt as context,
//   - shows proposed file edits in the IDE's diff view for Accept/Reject,
//   - exposes ide_get_diagnostics and ide_open_file tools to the agent.
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { getConfigDirectory } from './config.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_DIR = path.join(APP_ROOT, 'ide', 'vscode');

export function ideLockDirectory(env = process.env) { return path.join(getConfigDirectory(env), 'ide'); }

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function contains(folder, target) {
  const rel = path.relative(path.resolve(folder), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function listIdeLocks(env = process.env) {
  const dir = ideLockDirectory(env);
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const locks = [];
  for (const name of names.filter((item) => /^\d+\.lock$/.test(item))) {
    try {
      const lock = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (Number.isInteger(lock.port) && typeof lock.authToken === 'string' && alive(lock.pid)) locks.push(lock);
    } catch { /* ignore stale or partial lock files */ }
  }
  return locks;
}

export class IdeClient {
  constructor(lock, options = {}) {
    this.port = lock.port;
    this.token = lock.authToken;
    this.ideName = lock.ideName || 'IDE';
    this.workspaceFolders = Array.isArray(lock.workspaceFolders) ? lock.workspaceFolders : [];
    this.fetch = options.fetch || globalThis.fetch;
  }

  async call(method, params = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch('http://127.0.0.1:' + this.port + '/rpc', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.token },
        body: JSON.stringify({ method, params })
      });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(body.error || 'IDE bridge returned HTTP ' + response.status);
      return body.result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(this.ideName + ' did not answer ' + method + ' in time.');
      throw error;
    } finally { clearTimeout(timer); }
  }
}

/** Find and ping the IDE bridge for this workspace; null when none is running. */
export async function discoverIde(root, env = process.env, options = {}) {
  if (/^(0|off|false)$/i.test(String(env.OASIS_IDE || ''))) return null;
  const locks = await listIdeLocks(env);
  const port = Number(env.OASIS_IDE_PORT || 0);
  const ordered = [
    ...locks.filter((lock) => port && lock.port === port),
    ...locks.filter((lock) => lock.port !== port && (lock.workspaceFolders || []).some((folder) => contains(folder, root)))
  ];
  for (const lock of ordered) {
    const client = new IdeClient(lock, options);
    try { await client.call('ping', {}, 1500); return client; } catch { /* try the next lock */ }
  }
  return null;
}

export const IDE_TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'ide_get_diagnostics', description: 'Get errors and warnings from the user\'s IDE (language servers, linters, type checkers) for one file or the whole workspace. Use after edits to verify them, and before guessing at build errors.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative or absolute file path. Omit for all files with diagnostics.' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'ide_open_file', description: 'Open a file in the user\'s IDE at a line, to show them code you are discussing.', parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false } } }
];
export const IDE_TOOL_NAMES = new Set(IDE_TOOL_DEFINITIONS.map((tool) => tool.function.name));

export function attachIde(session, client) {
  session.ide = client;
  const names = new Set(session.toolDefinitions.map((tool) => tool.function.name));
  session.toolDefinitions = session.toolDefinitions.concat(IDE_TOOL_DEFINITIONS.filter((tool) => !names.has(tool.function.name)));
  const note = '\n\nIDE: connected to ' + client.ideName + '. The user\'s current editor selection is attached to prompts in <ide_selection> tags. Use ide_get_diagnostics to check for errors after editing, and ide_open_file to show code.';
  if (session.messages[0] && session.messages[0].role === 'system' && !String(session.messages[0].content).includes('IDE: connected to')) {
    session.messages[0].content += note;
    if (session.baseSystemPrompt) session.baseSystemPrompt += note;
  }
  return client;
}

export async function runIdeTool(session, name, args = {}) {
  if (!session.ide) throw new Error('No IDE is connected. Ask the user to run /ide or start OASIS from a VS Code terminal.');
  if (name === 'ide_get_diagnostics') {
    const result = await session.ide.call('getDiagnostics', { path: args.path ? path.resolve(session.root, String(args.path)) : undefined }, 10000);
    const files = Array.isArray(result && result.files) ? result.files : [];
    return { files, total: files.reduce((sum, file) => sum + file.diagnostics.length, 0) };
  }
  if (name === 'ide_open_file') return await session.ide.call('openFile', { path: path.resolve(session.root, String(args.path)), line: args.line }, 10000);
  throw new Error('Unknown IDE tool ' + name);
}

/** Context block for the current editor selection, or null when there is none. */
export async function ideSelectionContext(session) {
  if (!session || !session.ide) return null;
  let selection;
  try { selection = await session.ide.call('getSelection', {}, 1500); } catch { return null; }
  if (!selection || !selection.filePath) return null;
  const file = selection.relativePath || selection.filePath;
  if (selection.isEmpty || !selection.text) {
    return { label: 'In ' + file, text: '<ide_selection>The user has ' + file + ' open in the IDE (cursor at line ' + selection.startLine + '). This may or may not relate to the request.</ide_selection>' };
  }
  const lines = selection.endLine - selection.startLine + 1;
  return {
    label: 'Selected ' + lines + ' line' + (lines === 1 ? '' : 's') + ' from ' + file,
    text: '<ide_selection>The user selected lines ' + selection.startLine + '-' + selection.endLine + ' of ' + file + ':\n```' + (selection.languageId || '') + '\n' + String(selection.text).slice(0, 20000) + '\n```\nThis may or may not relate to the request.</ide_selection>'
  };
}

/** Compute a proposed file's new content for an edit tool call, or null if not applicable. */
export async function proposedContent(root, tool, input = {}) {
  if (!input || typeof input.path !== 'string') return null;
  const file = path.resolve(root, input.path);
  if (tool === 'write_file') return typeof input.content === 'string' ? { file, content: input.content, action: 'write' } : null;
  let current;
  try { current = await readFile(file, 'utf8'); } catch { return null; }
  const apply = (text, oldString, newString, all) => {
    if (typeof oldString !== 'string' || !oldString || typeof newString !== 'string' || !text.includes(oldString)) return null;
    return all ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
  };
  if (tool === 'edit_file') {
    const next = apply(current, input.old_string, input.new_string, input.replace_all);
    return next === null ? null : { file, content: next, action: 'edit' };
  }
  if (tool === 'multi_edit' && Array.isArray(input.edits)) {
    let next = current;
    for (const edit of input.edits) { next = apply(next, edit && edit.old_string, edit && edit.new_string, edit && edit.replace_all); if (next === null) return null; }
    return { file, content: next, action: 'edit' };
  }
  return null;
}

/**
 * Show an edit approval in the IDE diff view. Returns true/false for the user's choice,
 * or null when the IDE could not show it (the caller falls back to the terminal prompt).
 */
export async function reviewEditInIde(session, meta = {}) {
  if (!session || !session.ide || !meta.tool) return null;
  const change = await proposedContent(session.root, meta.tool, meta.input);
  if (!change) return null;
  try {
    const result = await session.ide.call('openDiff', { path: change.file, newContent: change.content, action: change.action, title: 'OASIS' }, 30 * 60 * 1000);
    return result && result.decision === 'accept';
  } catch { return null; }
}

// ---------- packaging and install ----------

const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, compressed);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Build a .vsix for the bundled extension without external tooling. */
export async function packageExtension(outFile) {
  const manifest = JSON.parse(await readFile(path.join(EXTENSION_DIR, 'package.json'), 'utf8'));
  const files = ['package.json', 'README.md', 'src/extension.js', 'src/server.js'];
  const entries = [];
  for (const file of files) entries.push({ name: 'extension/' + file, data: await readFile(path.join(EXTENSION_DIR, file)) });
  try { entries.push({ name: 'extension/LICENSE.txt', data: await readFile(path.join(APP_ROOT, 'LICENSE')) }); } catch {}
  const vsixManifest = '<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">\n'
    + '<Metadata><Identity Language="en-US" Id="' + xml(manifest.name) + '" Version="' + xml(manifest.version) + '" Publisher="' + xml(manifest.publisher) + '"/>'
    + '<DisplayName>' + xml(manifest.displayName) + '</DisplayName><Description xml:space="preserve">' + xml(manifest.description) + '</Description>'
    + '<Categories>' + xml((manifest.categories || []).join(',')) + '</Categories><GalleryFlags>Public</GalleryFlags>'
    + '<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="' + xml(manifest.engines.vscode) + '"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata>'
    + '<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>'
    + '<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>\n';
  const contentTypes = '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>\n';
  const archive = zip([{ name: '[Content_Types].xml', data: Buffer.from(contentTypes) }, { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest) }, ...entries]);
  await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await writeFile(outFile, archive);
  return { file: path.resolve(outFile), version: manifest.version, bytes: archive.length };
}

export function editorClis() {
  return ['code', 'cursor', 'windsurf', 'code-insiders', 'codium'].filter((cli) => {
    const probe = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 10000, shell: process.platform === 'win32' });
    return probe.status === 0;
  });
}

export async function ideCli(root, args = [], options = {}) {
  const env = options.env || process.env;
  const out = options.write || ((text) => process.stdout.write(text));
  const [action = 'status', value] = args;
  if (action === 'package') {
    const result = await packageExtension(value || path.join(root, 'oasis-vscode.vsix'));
    out('Built ' + result.file + ' (v' + result.version + ', ' + result.bytes + ' bytes). Install with: code --install-extension ' + result.file + '\n');
    return;
  }
  if (action === 'install') {
    const vsix = path.join(getConfigDirectory(env), 'ide', 'oasis-vscode.vsix');
    await packageExtension(vsix);
    const clis = value ? [value] : editorClis();
    if (!clis.length) { out('Built ' + vsix + '. No editor CLI (code, cursor, windsurf) was found on PATH; install it from VS Code with "Extensions: Install from VSIX...".\n'); return; }
    for (const cli of clis) {
      const result = spawnSync(cli, ['--install-extension', vsix, '--force'], { encoding: 'utf8', timeout: 120000, shell: process.platform === 'win32' });
      out((result.status === 0 ? 'Installed in ' : 'Could not install in ') + cli + (result.status === 0 ? '' : ': ' + String(result.stderr || result.stdout).trim().slice(0, 300)) + '\n');
    }
    out('Reload the editor window, then run oasis in its integrated terminal (or press Ctrl/Cmd+Esc).\n');
    return;
  }
  const locks = await listIdeLocks(env);
  const client = await discoverIde(root, env);
  out(client ? 'Connected IDE available: ' + client.ideName + ' (port ' + client.port + ')\n' : 'No IDE bridge found for ' + root + '.\n');
  if (!client && locks.length) out('Running IDE bridges: ' + locks.map((lock) => (lock.ideName || 'IDE') + ' [' + (lock.workspaceFolders || []).join(', ') + ']').join('; ') + '\n');
  if (!client) out('Install the extension with: oasis ide install\n');
}

export async function extensionFilesExist() {
  try { await stat(path.join(EXTENSION_DIR, 'src', 'extension.js')); return true; } catch { return false; }
}
