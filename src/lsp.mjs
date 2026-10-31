// Language Server Protocol client and the `lsp` agent tool: go to definition,
// find references, hover, implementations, type definitions, document and
// workspace symbols, call hierarchy, and pushed/pulled diagnostics.
//
// Servers are started on demand (one per language per session), kept warm for
// later calls, and stopped when the session closes. Built-in servers:
//   typescript  tsc --lsp --stdio (TypeScript 7+) or typescript-language-server --stdio
//                                                   .ts .tsx .js .jsx .mjs .cjs .mts .cts
//   python      pyright-langserver --stdio (or basedpyright-langserver, pylsp)  .py .pyi
//   go          gopls                                .go
//   rust        rust-analyzer                        .rs
//   c/c++       clangd                               .c .h .cc .cpp .hpp .cxx .m .mm
//   java        jdtls                                .java
//   ruby        ruby-lsp                             .rb
//   php         intelephense --stdio                 .php
//   lua         lua-language-server                  .lua
//   csharp      csharp-ls                            .cs
//   kotlin      kotlin-language-server               .kt .kts
//   swift       sourcekit-lsp                        .swift
// Extra servers come from trusted settings: "lspServers": { "name": { "command",
// "args", "extensions", "languageId" } }.
//
// Starting a language server runs a local program, so it needs approval once per
// server per session unless commands are auto-approved or a rule allows `lsp`.
import { spawn } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import { readFile, stat, realpath, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { findBinary } from './diagnostics.mjs';

const workspaceTools = () => import('./tools.mjs');

export const LSP_OPERATIONS = ['definition', 'references', 'hover', 'implementation', 'type_definition', 'document_symbols', 'workspace_symbols', 'incoming_calls', 'outgoing_calls', 'diagnostics'];
const REQUEST_TIMEOUT = 30000;
const INIT_TIMEOUT = 60000;
const MAX_RESULTS = 100;
const MAX_FRAME = 64 * 1024 * 1024;

export const LSP_TOOL_DEFINITION = { type: 'function', function: { name: 'lsp', description: 'Code intelligence from a language server (TypeScript/JavaScript, Python, Go, Rust, C/C++, Java, Ruby, PHP, Lua, C#, Kotlin, Swift). Operations: definition, references, hover (type and docs), implementation, type_definition, document_symbols (outline of a file), workspace_symbols (find a class/function by name; give any file of that language as path), incoming_calls / outgoing_calls (call hierarchy), diagnostics (type errors for one file). Point at a symbol with line and column (1-based), or give symbol to use its first occurrence (on line, when given). Much more precise than grep for navigating code.', parameters: { type: 'object', properties: {
  operation: { type: 'string', enum: LSP_OPERATIONS },
  path: { type: 'string', description: 'Workspace-relative source file' },
  line: { type: 'integer', description: '1-based line of the symbol' },
  column: { type: 'integer', description: '1-based column of the symbol' },
  symbol: { type: 'string', description: 'Symbol name to locate in the file instead of an exact column' },
  query: { type: 'string', description: 'Search text for workspace_symbols' },
  include_declaration: { type: 'boolean', description: 'references: include the declaration itself; default true' }
}, required: ['operation', 'path'] } } };

const C_EXT = ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.m', '.mm'];
export const BUILTIN_SERVERS = [
  { name: 'typescript', extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'], candidates: [{ command: 'typescript-language-server', args: ['--stdio'], node: true }], install: 'npm install -g typescript (7+ includes a server) or typescript typescript-language-server for TypeScript 5/6' },
  { name: 'python', extensions: ['.py', '.pyi'], candidates: [{ command: 'pyright-langserver', args: ['--stdio'], node: true, python: true }, { command: 'basedpyright-langserver', args: ['--stdio'], python: true }, { command: 'pylsp', args: [], python: true }], install: 'npm install -g pyright (or pip install python-lsp-server)' },
  { name: 'go', extensions: ['.go'], candidates: [{ command: 'gopls', args: [] }], install: 'go install golang.org/x/tools/gopls@latest' },
  { name: 'rust', extensions: ['.rs'], candidates: [{ command: 'rust-analyzer', args: [] }], install: 'rustup component add rust-analyzer' },
  { name: 'c', extensions: C_EXT, candidates: [{ command: 'clangd', args: [] }], install: 'install clangd from your package manager' },
  { name: 'java', extensions: ['.java'], candidates: [{ command: 'jdtls', args: [] }], install: 'install Eclipse JDT Language Server (jdtls)' },
  { name: 'ruby', extensions: ['.rb'], candidates: [{ command: 'ruby-lsp', args: [] }, { command: 'solargraph', args: ['stdio'] }], install: 'gem install ruby-lsp' },
  { name: 'php', extensions: ['.php'], candidates: [{ command: 'intelephense', args: ['--stdio'], node: true }], install: 'npm install -g intelephense' },
  { name: 'lua', extensions: ['.lua'], candidates: [{ command: 'lua-language-server', args: [] }], install: 'install lua-language-server' },
  { name: 'csharp', extensions: ['.cs'], candidates: [{ command: 'csharp-ls', args: [] }], install: 'dotnet tool install -g csharp-ls' },
  { name: 'kotlin', extensions: ['.kt', '.kts'], candidates: [{ command: 'kotlin-language-server', args: [] }], install: 'install kotlin-language-server' },
  { name: 'swift', extensions: ['.swift'], candidates: [{ command: 'sourcekit-lsp', args: [] }], install: 'sourcekit-lsp ships with the Swift toolchain' }
];

const LANGUAGE_IDS = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.m': 'objective-c', '.mm': 'objective-cpp', '.java': 'java', '.rb': 'ruby', '.php': 'php', '.lua': 'lua', '.cs': 'csharp', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift'
};

const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];

// ---------------------------------------------------------------- JSON-RPC client
export class LspClient {
  constructor({ command, args = [], cwd, env, name, initializationOptions = {} }) {
    this.initializationOptions = initializationOptions;
    this.name = name || command;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.documents = new Map();
    this.diagnostics = new Map();
    this.staleDiagnostics = new Set();
    this.diagnosticWaiters = new Map();
    this.capabilities = {};
    this.stderr = '';
    this.closed = false;
    this.stopPromise = null;
  }

  start() {
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...processTreeSpawnOptions() });
    this.exitPromise = new Promise((resolve) => {
      this.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdin.on('error', () => {});
    const fail = (message) => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(message)); }
      this.pending.clear();
    };
    this.child.on('error', (error) => fail('Language server ' + this.name + ' failed to start: ' + error.message));
    this.child.on('exit', (code, signal) => {
      fail('Language server ' + this.name + ' exited (' + (signal || code) + ')' + (this.stderr.trim() ? ': ' + this.stderr.trim().split('\n').slice(-3).join(' ') : ''));
      // Some language servers delegate to worker processes. Clean the process
      // group even when the server leader exits before its descendants.
      signalProcessTree(this.child, 'SIGTERM');
      const killTimer = setTimeout(() => signalProcessTree(this.child, 'SIGKILL'), 750);
      killTimer.unref?.();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) { this.buffer = this.buffer.slice(headerEnd + 4); continue; }
      const length = Number(match[1]);
      if (length > MAX_FRAME) { this.stop(); return; }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.slice(headerEnd + 4 + length);
      let message;
      try { message = JSON.parse(body); } catch { continue; }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(this.name + ': ' + (message.error.message || 'request failed')));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics' && message.params) {
      this.diagnostics.set(message.params.uri, message.params.diagnostics || []);
      this.staleDiagnostics.delete(message.params.uri);
      const waiters = this.diagnosticWaiters.get(message.params.uri);
      if (waiters) { this.diagnosticWaiters.delete(message.params.uri); for (const resolve of waiters) resolve(); }
      return;
    }
    if (message.id !== undefined && message.method) {
      // Server-to-client requests: answer the common ones so servers do not stall.
      let result = null;
      if (message.method === 'workspace/configuration') result = (message.params && message.params.items || []).map(() => null);
      else if (message.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.cwd).href, name: path.basename(this.cwd) }];
      this.send({ jsonrpc: '2.0', id: message.id, result });
    }
  }

  send(message) {
    if (this.closed || !this.child || !this.child.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write('Content-Length: ' + body.length + '\r\n\r\n');
    this.child.stdin.write(body);
  }

  request(method, params, timeout = REQUEST_TIMEOUT) {
    if (this.closed) return Promise.reject(new Error('Language server ' + this.name + ' is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(this.name + ' did not answer ' + method + ' within ' + Math.round(timeout / 1000) + 's.')); }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

  async initialize() {
    const rootUri = pathToFileURL(this.cwd).href;
    const result = await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'oasis' },
      rootUri,
      rootPath: this.cwd,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.cwd) }],
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false } },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          definition: { linkSupport: true }, typeDefinition: { linkSupport: true }, implementation: { linkSupport: true },
          references: {}, hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: {}, publishDiagnostics: { relatedInformation: false }, diagnostic: {}
        }
      },
      initializationOptions: this.initializationOptions
    }, INIT_TIMEOUT);
    this.capabilities = result && result.capabilities || {};
    this.notify('initialized', {});
    return this.capabilities;
  }

  // Open the file, or push its new text if it changed on disk since we last sent it.
  async sync(absolute, languageId) {
    const uri = pathToFileURL(absolute).href;
    const info = await stat(absolute);
    const known = this.documents.get(uri);
    if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return { uri, text: known.text, changed: false };
    const text = await readFile(absolute, 'utf8');
    this.staleDiagnostics.add(uri);
    if (!known) {
      this.documents.set(uri, { version: 1, mtimeMs: info.mtimeMs, size: info.size, text });
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    } else {
      const version = known.version + 1;
      this.documents.set(uri, { version, mtimeMs: info.mtimeMs, size: info.size, text });
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
      this.notify('textDocument/didSave', { textDocument: { uri } });
    }
    return { uri, text, changed: true };
  }

  async resyncOpenDocuments() {
    for (const uri of [...this.documents.keys()]) {
      const absolute = fileURLToPath(uri);
      try { await this.sync(absolute, LANGUAGE_IDS[path.extname(absolute).toLowerCase()] || 'plaintext'); }
      catch { this.documents.delete(uri); this.notify('textDocument/didClose', { textDocument: { uri } }); }
    }
  }

  waitForDiagnostics(uri, timeout) {
    return new Promise((resolve) => {
      let timer;
      let settled = false;
      const finish = (received) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const list = this.diagnosticWaiters.get(uri) || [];
        const next = list.filter((waiter) => waiter !== onDiagnostics);
        if (next.length) this.diagnosticWaiters.set(uri, next);
        else this.diagnosticWaiters.delete(uri);
        resolve(received);
      };
      const onDiagnostics = () => finish(true);
      timer = setTimeout(() => finish(false), timeout);
      timer.unref?.();
      const list = this.diagnosticWaiters.get(uri) || [];
      list.push(onDiagnostics);
      this.diagnosticWaiters.set(uri, list);
    });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      this.closed = true;
      return Promise.resolve();
    }
    this.stopPromise = (async () => {
      const hasExited = () => child.exitCode !== null || child.signalCode !== null;
      if (!hasExited() && !this.closed) {
        try { await this.request('shutdown', null, 2000); } catch {}
        try { this.notify('exit', null); } catch {}
        try { child.stdin.end(); } catch {}
      }
      this.closed = true;

      // Wait for the server's graceful shutdown before escalating to the whole
      // process group. The leader may exit while helper processes keep running.
      if (!hasExited()) {
        const graceful = await Promise.race([
          this.exitPromise.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 500))
        ]);
        if (!graceful && !hasExited()) signalProcessTree(child, 'SIGTERM');
      }
      const terminated = await Promise.race([
        this.exitPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 750))
      ]);
      if (!terminated) signalProcessTree(child, 'SIGKILL');
      await this.exitPromise;
    })();
    return this.stopPromise;
  }
}

// ---------------------------------------------------------------- server selection
export function serverForFile(file, settings = {}) {
  const ext = path.extname(file).toLowerCase();
  const custom = settings && settings.lspServers && typeof settings.lspServers === 'object' ? settings.lspServers : {};
  for (const [name, spec] of Object.entries(custom)) {
    if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.extensions)) continue;
    if (spec.extensions.map((item) => String(item).toLowerCase()).includes(ext)) {
      return { name, extensions: spec.extensions, languageId: spec.languageId, languageIds: spec.languageIds || {}, env: spec.env, plugin: spec.plugin, candidates: [{ command: spec.command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], custom: true, initializationOptions: spec.initializationOptions, settings: spec.settings }] };
    }
  }
  return BUILTIN_SERVERS.find((server) => server.extensions.includes(ext)) || null;
}

function absoluteBinary(root, binary, env, spawnSync) {
  if (path.isAbsolute(binary)) return binary;
  if (binary.startsWith('.')) return path.resolve(root, binary);
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [binary] : ['-c', 'command -v "$0"', binary], { encoding: 'utf8', env, timeout: 3000 });
  return String(probe.stdout || '').split(/\r?\n/)[0].trim() || null;
}

// TypeScript: TS 7+ (native) ships its own server as `tsc --lsp --stdio`; TS 5/6 need
// typescript-language-server plus a tsserver.js from the project or a global install.
async function resolveTypescript(root, env) {
  const { spawnSync } = await import('node:child_process');
  const tsc = await findBinary(root, 'tsc', env, { node: true });
  let tsserverLib = null;
  let nativeTsc = null;
  for (const lib of [path.join(root, 'node_modules', 'typescript', 'lib')]) {
    try { await access(path.join(lib, 'tsserver.js')); tsserverLib = lib; } catch {}
  }
  if (tsc) {
    const absolute = absoluteBinary(root, tsc, env, spawnSync);
    if (absolute) {
      try {
        const packageDir = path.join(path.dirname(await realpath(absolute)), '..');
        const pkg = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
        if (Number.parseInt(String(pkg.version), 10) >= 7) nativeTsc = tsc;
        else if (!tsserverLib) { await access(path.join(packageDir, 'lib', 'tsserver.js')); tsserverLib = path.join(packageDir, 'lib'); }
      } catch {}
    }
  }
  const tls = await findBinary(root, 'typescript-language-server', env, { node: true });
  if (tls && tsserverLib) return { command: tls, args: ['--stdio'], initializationOptions: { tsserver: { path: tsserverLib } } };
  if (nativeTsc) return { command: nativeTsc, args: ['--lsp', '--stdio'] };
  const tsgo = await findBinary(root, 'tsgo', env, { node: true });
  if (tsgo) return { command: tsgo, args: ['--lsp', '--stdio'] };
  if (tls) return { command: tls, args: ['--stdio'] };
  return null;
}

async function resolveServer(root, server, env) {
  if (server.name === 'typescript' && !server.candidates[0].custom) return await resolveTypescript(root, env);
  for (const candidate of server.candidates) {
    if (candidate.custom) return { command: candidate.command, args: candidate.args, initializationOptions: candidate.initializationOptions, settings: candidate.settings };
    const bin = await findBinary(root, candidate.command, env, { node: candidate.node, python: candidate.python });
    if (bin) return { command: bin, args: candidate.args };
  }
  return null;
}

export async function stopLspClients(session) {
  if (!session || !session.lspClients) return;
  const clients = [...session.lspClients.values()];
  session.lspClients.clear();
  await Promise.allSettled(clients.map(async (entry) => {
    try {
      const client = await entry;
      await client.stop();
    } catch {}
  }));
}

async function clientFor(root, server, options) {
  const session = options.session || (options.fallbackSession ||= {});
  const clients = session.lspClients || (session.lspClients = new Map());
  const existing = clients.get(server.name);
  if (existing) {
    const client = await existing.catch(() => null);
    if (client && !client.closed) return client;
    clients.delete(server.name);
  }
  const approved = session.lspApproved || (session.lspApproved = new Set());
  // Register the promise before any await so concurrent calls share one server.
  const starting = (async () => {
    const resolved = await resolveServer(root, server, options.env || process.env);
    if (!resolved) throw new Error('No ' + server.name + ' language server found. Install one with: ' + (server.install || 'your package manager') + '. Meanwhile, use grep or the diagnostics tool.');
    const key = resolved.command + ' ' + resolved.args.join(' ');
    if (!approved.has(key) && !options.autoApprove && !options.ruleAllowed) {
      const ok = options.approval && await options.approval('Start the ' + server.name + (server.plugin ? ' language server from plugin ' + server.plugin : ' language server') + ' for code navigation?\n  ' + key + '\nIt runs locally in the workspace, reads project files, and stays running until this session ends.');
      if (!ok) throw new Error('Starting the ' + server.name + ' language server was not approved. Use grep or read_file instead.');
    }
    approved.add(key);
    const { scrubEnvironment } = await workspaceTools();
    const client = new LspClient({ name: server.name, command: resolved.command, args: resolved.args, initializationOptions: resolved.initializationOptions || {}, cwd: root, env: scrubEnvironment({ ...(options.env || process.env), ...(server.env || {}) }) });
    client.start();
    await client.initialize();
    if (resolved.settings) client.notify('workspace/didChangeConfiguration', { settings: resolved.settings });
    return client;
  })();
  clients.set(server.name, starting);
  try { return await starting; } catch (error) { clients.delete(server.name); throw error; }
}

// ---------------------------------------------------------------- formatting helpers
function lineAt(text, line) {
  const lines = text.split(/\r?\n/);
  return lines[line] === undefined ? '' : lines[line];
}

export function locateSymbol(text, symbol, line) {
  const lines = text.split(/\r?\n/);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp((/^\w/.test(symbol) ? '\\b' : '') + escaped + (/\w$/.test(symbol) ? '\\b' : ''));
  const search = (index) => { const m = lines[index] !== undefined ? word.exec(lines[index]) : null; return m ? { line: index, character: m.index } : null; };
  if (line) {
    const hit = search(line - 1);
    if (hit) return hit;
    throw new Error('Symbol "' + symbol + '" was not found on line ' + line + '.');
  }
  for (let index = 0; index < lines.length; index++) { const hit = search(index); if (hit) return hit; }
  throw new Error('Symbol "' + symbol + '" was not found in the file.');
}

function hoverText(contents) {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join('\n\n');
  if (contents.kind || contents.value !== undefined) return contents.language ? '```' + contents.language + '\n' + contents.value + '\n```' : String(contents.value || '');
  return '';
}

async function describeLocations(raw, root, cache) {
  const { sensitivePath } = await workspaceTools();
  const list = !raw ? [] : Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list.slice(0, MAX_RESULTS)) {
    const uri = item.targetUri || item.uri;
    const range = item.targetSelectionRange || item.targetRange || item.range;
    if (!uri || !range) continue;
    let absolute;
    try { absolute = fileURLToPath(uri); } catch { out.push({ uri, line: range.start.line + 1, column: range.start.character + 1 }); continue; }
    const relative = path.relative(root, absolute);
    const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    const display = inside ? relative.split(path.sep).join('/') : absolute;
    const entry = { path: display, line: range.start.line + 1, column: range.start.character + 1 };
    if (!inside) entry.external = true;
    if (inside && sensitivePath(display)) { entry.text = '[hidden: sensitive file]'; out.push(entry); continue; }
    if (!cache.has(absolute)) cache.set(absolute, await readFile(absolute, 'utf8').catch(() => null));
    const text = cache.get(absolute);
    if (text !== null && text !== undefined) entry.text = lineAt(text, range.start.line).trim().slice(0, 300);
    out.push(entry);
  }
  return { locations: out, total: list.length, truncated: list.length > MAX_RESULTS };
}

function flattenSymbols(symbols, root, depth = 0, out = []) {
  for (const symbol of symbols || []) {
    if (out.length >= 400) break;
    const range = symbol.selectionRange || symbol.range || (symbol.location && symbol.location.range);
    const entry = { name: symbol.name, kind: SYMBOL_KINDS[symbol.kind] || String(symbol.kind), line: range ? range.start.line + 1 : null };
    if (symbol.detail) entry.detail = String(symbol.detail).slice(0, 200);
    if (symbol.containerName) entry.container = symbol.containerName;
    if (depth) entry.depth = depth;
    if (symbol.location && symbol.location.uri) {
      try {
        const relative = path.relative(root, fileURLToPath(symbol.location.uri));
        entry.path = relative.startsWith('..') ? fileURLToPath(symbol.location.uri) : relative.split(path.sep).join('/');
      } catch {}
    }
    out.push(entry);
    if (Array.isArray(symbol.children)) flattenSymbols(symbol.children, root, depth + 1, out);
  }
  return out;
}

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
function describeDiagnostics(list, relative) {
  return (list || []).slice(0, 200).map((item) => ({
    file: relative, line: item.range.start.line + 1, column: item.range.start.character + 1,
    severity: SEVERITY[item.severity] || 'error', message: String(item.message || '').slice(0, 600),
    ...(item.code !== undefined ? { code: String(item.code) } : {}), source: item.source || 'lsp'
  }));
}

// ---------------------------------------------------------------- tool entry point
export async function runLsp(root, args = {}, options = {}) {
  const runEnv = options.env || process.env;
  if (runEnv.OASIS_DISABLE_LSP === '1') {
    throw new Error('Language-server startup is disabled for unattended GitHub Action runs; use repository checks instead.');
  }
  const { resolveWorkspacePath, sensitivePath } = await workspaceTools();
  const operation = String(args.operation || '');
  if (!LSP_OPERATIONS.includes(operation)) throw new Error('operation must be one of: ' + LSP_OPERATIONS.join(', ') + '.');
  if (!args.path) throw new Error('lsp needs a path.');
  const target = await resolveWorkspacePath(root, args.path);
  const relative = path.relative(target.root, target.absolute).split(path.sep).join('/');
  if (sensitivePath(relative)) throw new Error('That file is protected.');
  const info = await stat(target.absolute).catch(() => null);
  if (!info || !info.isFile()) throw new Error('lsp needs an existing source file; ' + relative + ' is not a file.');
  const server = serverForFile(relative, options.settings);
  if (!server) throw new Error('No language server is known for ' + (path.extname(relative) || 'files without an extension') + '. Add one under "lspServers" in trusted settings, or use grep.');
  const languageId = (server.languageIds && server.languageIds[path.extname(relative).toLowerCase()]) || server.languageId || LANGUAGE_IDS[path.extname(relative).toLowerCase()] || server.name;
  const client = await clientFor(target.root, server, options);
  await client.resyncOpenDocuments();
  const { uri, text } = await client.sync(target.absolute, languageId);
  const cache = new Map([[target.absolute, text]]);
  const base = { operation, server: server.name, path: relative };

  if (operation === 'document_symbols') {
    const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    const list = flattenSymbols(symbols, target.root);
    return { ...base, symbols: list, count: list.length };
  }
  if (operation === 'workspace_symbols') {
    const query = String(args.query || args.symbol || '');
    if (!query) throw new Error('workspace_symbols needs a query.');
    const symbols = await client.request('workspace/symbol', { query });
    const list = flattenSymbols(symbols, target.root).filter((item) => !item.path || !sensitivePath(item.path)).slice(0, MAX_RESULTS);
    return { ...base, query, symbols: list, count: list.length };
  }
  if (operation === 'diagnostics') {
    const pull = client.capabilities.diagnosticProvider;
    let list = null;
    if (pull) {
      try {
        const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
        if (report && Array.isArray(report.items)) list = report.items;
      } catch { list = null; }
    }
    if (!list) {
      if (client.staleDiagnostics.has(uri) || !client.diagnostics.has(uri)) {
        const received = await client.waitForDiagnostics(uri, Number.isFinite(options.diagnosticTimeoutMs) ? Math.max(1, Math.min(30000, options.diagnosticTimeoutMs)) : 8000);
        if (!received && (client.staleDiagnostics.has(uri) || !client.diagnostics.has(uri))) {
          throw new Error('Timed out waiting for ' + server.name + ' language-server diagnostics for ' + relative + '. Verification is unavailable; no clean result was received.');
        }
      }
      if (!client.diagnostics.has(uri) || client.staleDiagnostics.has(uri)) {
        throw new Error('The ' + server.name + ' language server did not provide current diagnostics for ' + relative + '. Verification is unavailable.');
      }
      list = client.diagnostics.get(uri);
    }
    const diagnostics = describeDiagnostics(list, relative);
    return { ...base, diagnostics, summary: { errors: diagnostics.filter((d) => d.severity === 'error').length, warnings: diagnostics.filter((d) => d.severity === 'warning').length, total: diagnostics.length } };
  }

  let position;
  if (args.symbol) position = locateSymbol(text, String(args.symbol), args.line ? Number(args.line) : null);
  else {
    const line = Number.parseInt(args.line, 10);
    const column = Number.parseInt(args.column, 10);
    if (!(line >= 1)) throw new Error(operation + ' needs line and column (1-based) or symbol.');
    position = { line: line - 1, character: Math.max(0, (column || 1) - 1) };
  }
  base.position = { line: position.line + 1, column: position.character + 1, text: lineAt(text, position.line).trim().slice(0, 300) };
  const textDocument = { uri };

  if (operation === 'hover') {
    const hover = await client.request('textDocument/hover', { textDocument, position });
    const content = hoverText(hover && hover.contents).trim();
    return { ...base, hover: content ? content.slice(0, 6000) : null, ...(content ? {} : { message: 'No hover information at that position.' }) };
  }
  if (operation === 'incoming_calls' || operation === 'outgoing_calls') {
    if (!client.capabilities.callHierarchyProvider) throw new Error(server.name + ' does not support call hierarchy.');
    const items = await client.request('textDocument/prepareCallHierarchy', { textDocument, position });
    if (!items || !items.length) return { ...base, calls: [], message: 'No callable symbol at that position.' };
    const method = operation === 'incoming_calls' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls';
    const calls = await client.request(method, { item: items[0] });
    const out = [];
    for (const call of (calls || []).slice(0, MAX_RESULTS)) {
      const item = call.from || call.to;
      const described = await describeLocations([{ uri: item.uri, range: item.selectionRange || item.range }], target.root, cache);
      out.push({ name: item.name, kind: SYMBOL_KINDS[item.kind] || String(item.kind), ...(described.locations[0] || {}) });
    }
    return { ...base, symbol: items[0].name, calls: out, count: out.length };
  }
  const methods = { definition: 'textDocument/definition', references: 'textDocument/references', implementation: 'textDocument/implementation', type_definition: 'textDocument/typeDefinition' };
  const params = { textDocument, position };
  if (operation === 'references') params.context = { includeDeclaration: args.include_declaration !== false };
  const raw = await client.request(methods[operation], params);
  const described = await describeLocations(raw, target.root, cache);
  return { ...base, ...described, ...(described.locations.length ? {} : { message: 'No results at that position. Check line/column, or try symbol.' }) };
}


// Compare current LSP diagnostics with an optional pre-edit baseline. This helper
// never turns server startup/timeout failures into a successful verification.
function diagnosticIdentity(item) {
  return [String(item.severity || 'information').toLowerCase(), String(item.code || ''), String(item.message || '')].join('\0');
}

function diagnosticDifference(current, baseline) {
  if (!Array.isArray(baseline)) return [...current];
  const remaining = new Map();
  for (const item of baseline) {
    const key = diagnosticIdentity(item);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  const added = [];
  for (const item of current) {
    const key = diagnosticIdentity(item);
    const count = remaining.get(key) || 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push(item);
  }
  return added;
}

function isSeverity(item, severity) {
  const value = String(item && item.severity || '').toLowerCase();
  return value === severity || (severity === 'error' && value === '1') ||
    (severity === 'warning' && value === '2') ||
    (severity === 'information' && (value === '3' || value === '4' || value === 'info'));
}

/**
 * Collect diagnostics after a successful source-file edit. baselineDiagnostics
 * may be omitted when no language server was already active before the edit; in
 * that case existing errors are conservatively reported as unclassified blockers.
 */
export async function verifyEditedFileWithLsp(root, file, options = {}) {
  const settings = options.settings || options.session && options.session.settings || {};
  const server = serverForFile(file, settings);
  if (!server) return { status: 'not_applicable', path: file, blocking: false, reason: 'No language server is configured for this file type.' };
  try {
    const checked = await runLsp(root, { operation: 'diagnostics', path: file }, options);
    const diagnostics = Array.isArray(checked.diagnostics) ? checked.diagnostics : [];
    const baselineKnown = Array.isArray(options.baselineDiagnostics);
    const added = diagnosticDifference(diagnostics, options.baselineDiagnostics);
    const newErrors = added.filter((item) => isSeverity(item, 'error'));
    const newWarnings = added.filter((item) => isSeverity(item, 'warning'));
    const newInformation = added.filter((item) => isSeverity(item, 'information'));
    const existingErrors = baselineKnown
      ? diagnostics.filter((item) => isSeverity(item, 'error') && !newErrors.includes(item))
      : [];
    const status = newErrors.length ? 'issues' : newWarnings.length ? 'warnings' : 'verified';
    return {
      status,
      path: checked.path || file,
      server: checked.server || server.name,
      baselineKnown,
      summary: checked.summary || {
        errors: diagnostics.filter((item) => isSeverity(item, 'error')).length,
        warnings: diagnostics.filter((item) => isSeverity(item, 'warning')).length,
        total: diagnostics.length
      },
      diagnostics: diagnostics.slice(0, 100),
      ...(diagnostics.length > 100 ? { diagnosticsTruncated: true } : {}),
      newErrors,
      newWarnings,
      newInformation,
      existingErrors,
      ...(baselineKnown ? {} : { note: 'No pre-edit LSP baseline was available; remaining diagnostics are conservatively treated as new until reviewed.' })
    };
  } catch (error) {
    const reason = String(error && error.message || error).slice(0, 600);
    const customServer = Boolean(settings.lspServers && Object.values(settings.lspServers).some((spec) =>
      spec && Array.isArray(spec.extensions) && spec.extensions.map((ext) => String(ext).toLowerCase()).includes(path.extname(file).toLowerCase())
    ));
    // A missing optional built-in executable is not a new diagnostic. Keep the
    // unavailable status visible, while the independent project-check gate remains
    // responsible for deciding whether this edit can be considered verified.
    const disabledByPolicy = /Language-server startup is disabled for unattended GitHub Action runs/i.test(reason);
    const missingOptionalServer = disabledByPolicy || (!customServer &&
      /No \S+ language server found\./i.test(reason));
    return {
      status: 'unavailable',
      blocking: !missingOptionalServer,
      path: file,
      server: server.name,
      reason
    };
  }
}
