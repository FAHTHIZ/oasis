// Host methods of the Codex App Server protocol that work without a thread:
// fs/readFile, fs/writeFile, fs/createDirectory, fs/getMetadata,
// fs/readDirectory, fs/remove, fs/copy, fs/watch, fs/unwatch (+ fs/changed),
// command/exec, command/exec/write, command/exec/resize,
// command/exec/terminate (+ command/exec/outputDelta), fuzzyFileSearch and
// gitDiffToRemote.
//
// Shapes follow codex-rs/app-server-protocol/src/protocol/v2/{fs,command_exec}.rs
// (Apache-2.0); this is an independent implementation.
//
// Differences from Codex, on purpose:
// - Every path must sit inside an allowed root: the server's working folder,
//   the folder of any thread opened on this connection, and folders listed in
//   OASIS_APP_SERVER_FS_ROOTS (path-delimiter separated). Symlinks are resolved
//   before the check, so a link cannot reach outside a root.
// - command/exec runs through the sandbox configured in OASIS settings
//   (bubblewrap, Seatbelt, containers, SSH), the same wrapper agent commands use.
//   When the sandbox is enabled but unavailable the command is refused.
// - fuzzyFileSearch lists files the way OASIS's own tools do (git-visible
//   files, no secrets, no dependency folders) and ranks them with the prompt's
//   @-mention matcher rather than Codex's nucleo matcher, so scores differ.
//   Like Codex it returns at most 50 matches, includes folders, and a newer
//   request with the same cancellationToken makes the older one return empty.
// - PTY mode needs the optional node-pty component; without it the request
//   fails with a clear message instead of falling back silently.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { signalProcessTree } from './process-tree.mjs';

const DEFAULT_OUTPUT_CAP = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_PROCESSES = 16;
const MAX_WATCHES = 64;
const WATCH_DEBOUNCE_MS = 150;
const FUZZY_MATCH_LIMIT = 50;

function rpcError(code, message) {
  const error = new Error(message);
  error.rpc = { code, message };
  return error;
}
const invalid = (message) => rpcError(-32602, message);

export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolve symlinks for the longest existing prefix of `target`, then append the
// part that does not exist yet. A path that does not exist at all is checked by
// its nearest existing parent.
async function resolveReal(target) {
  let current = target;
  const tail = [];
  for (;;) {
    try { return path.join(await realpath(current), ...tail.reverse()); }
    catch (error) {
      if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function createAppServerHost(options = {}) {
  const env = options.env || process.env;
  const notify = options.notify || (() => {});
  const roots = new Set();
  const processes = new Map();
  const watches = new Map();
  const spawnProcess = options.spawn || spawn;
  const loadPty = options.loadPty || (() => import('node-pty'));
  const getSandbox = options.getSandbox || (async () => null);
  const launch = options.launch || (async (command, args, sandbox, cwd) => {
    if (!sandbox || !sandbox.enabled) return { command, args };
    const { launchCommand } = await import('./sandbox.mjs');
    return launchCommand(command, args, sandbox, cwd);
  });

  function addRoot(dir) { if (typeof dir === 'string' && dir) roots.add(path.resolve(dir)); }
  addRoot(options.cwd || process.cwd());
  for (const dir of String(env.OASIS_APP_SERVER_FS_ROOTS || '').split(path.delimiter)) if (dir.trim()) addRoot(dir.trim());

  async function realRoots() {
    const list = [];
    for (const root of roots) list.push(await resolveReal(root));
    return list;
  }

  async function allowed(raw, field = 'path') {
    if (typeof raw !== 'string' || !raw) throw invalid(field + ' is required.');
    if (!path.isAbsolute(raw)) throw invalid(field + ' must be an absolute path.');
    if (raw.includes('\0')) throw invalid(field + ' contains a NUL byte.');
    const target = path.resolve(raw);
    const real = await resolveReal(target);
    for (const root of await realRoots()) if (isInside(root, real)) return target;
    throw rpcError(-32001, field + ' is outside the folders this App Server may use: ' + target + '. Open a thread there or add it to OASIS_APP_SERVER_FS_ROOTS.');
  }

  async function fsError(fn) {
    try { return await fn(); }
    catch (error) {
      if (error && error.rpc) throw error;
      throw rpcError(-32000, String(error && error.code ? error.code + ': ' : '') + String(error && error.message || error));
    }
  }

  // ---- fs/* ----------------------------------------------------------------

  async function readFileMethod(params) {
    const file = await allowed(params.path);
    return fsError(async () => {
      const info = await stat(file);
      if (!info.isFile()) throw rpcError(-32000, 'Not a file: ' + file);
      if (info.size > MAX_READ_BYTES) throw rpcError(-32000, 'File is larger than ' + MAX_READ_BYTES + ' bytes: ' + file);
      return { dataBase64: (await readFile(file)).toString('base64') };
    });
  }

  async function writeFileMethod(params) {
    const file = await allowed(params.path);
    if (typeof params.dataBase64 !== 'string') throw invalid('dataBase64 is required.');
    return fsError(async () => { await writeFile(file, Buffer.from(params.dataBase64, 'base64')); return {}; });
  }

  async function createDirectory(params) {
    const dir = await allowed(params.path);
    return fsError(async () => { await mkdir(dir, { recursive: params.recursive !== false }); return {}; });
  }

  async function getMetadata(params) {
    const file = await allowed(params.path);
    return fsError(async () => {
      const link = await lstat(file);
      const info = link.isSymbolicLink() ? await stat(file).catch(() => link) : link;
      return { isDirectory: info.isDirectory(), isFile: info.isFile(), isSymlink: link.isSymbolicLink(), createdAtMs: Math.floor(info.birthtimeMs || info.ctimeMs || 0), modifiedAtMs: Math.floor(info.mtimeMs || 0) };
    });
  }

  async function readDirectory(params) {
    const dir = await allowed(params.path);
    return fsError(async () => {
      const entries = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          const info = await stat(path.join(dir, entry.name)).catch(() => null);
          isDirectory = Boolean(info && info.isDirectory());
          isFile = Boolean(info && info.isFile());
        }
        entries.push({ fileName: entry.name, isDirectory, isFile });
      }
      entries.sort((a, b) => a.fileName.localeCompare(b.fileName));
      return { entries };
    });
  }

  async function remove(params) {
    const file = await allowed(params.path);
    for (const root of await realRoots()) if (path.relative(root, await resolveReal(file)) === '') throw rpcError(-32001, 'Refusing to remove an App Server root folder: ' + file);
    return fsError(async () => { await rm(file, { recursive: params.recursive !== false, force: params.force !== false }); return {}; });
  }

  async function copy(params) {
    const from = await allowed(params.sourcePath, 'sourcePath');
    const to = await allowed(params.destinationPath, 'destinationPath');
    return fsError(async () => {
      const info = await stat(from);
      if (info.isDirectory() && !params.recursive) throw rpcError(-32000, 'sourcePath is a directory; set recursive: true to copy it.');
      if (info.isDirectory() && isInside(from, to)) throw rpcError(-32000, 'Cannot copy a directory into itself.');
      await cp(from, to, { recursive: Boolean(params.recursive), force: true, errorOnExist: false });
      return {};
    });
  }

  async function watchMethod(params) {
    if (typeof params.watchId !== 'string' || !params.watchId) throw invalid('watchId is required.');
    if (watches.has(params.watchId)) throw rpcError(-32000, 'watchId is already in use: ' + params.watchId);
    if (watches.size >= MAX_WATCHES) throw rpcError(-32000, 'Too many watches on this connection (' + MAX_WATCHES + ').');
    const target = await allowed(params.path);
    return fsError(async () => {
      const info = await stat(target);
      const base = info.isDirectory() ? target : path.dirname(target);
      const changed = new Set();
      let timer = null;
      const flush = () => { timer = null; const list = [...changed]; changed.clear(); if (list.length && watches.has(params.watchId)) notify('fs/changed', { watchId: params.watchId, changedPaths: list.sort() }); };
      const watcher = watch(target, { recursive: info.isDirectory() && process.platform !== 'linux' ? true : false }, (_event, name) => {
        const file = name ? path.resolve(base, String(name)) : target;
        if (!info.isDirectory() && file !== target) return;
        changed.add(file);
        if (!timer) timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => {});
      watches.set(params.watchId, { watcher, clear: () => { if (timer) clearTimeout(timer); } });
      return { path: target };
    });
  }

  async function unwatch(params) {
    const entry = watches.get(params.watchId);
    if (entry) { entry.clear(); try { entry.watcher.close(); } catch {} watches.delete(params.watchId); }
    return {};
  }

  // ---- command/exec ----------------------------------------------------------

  function commandEnv(overrides) {
    const result = { ...env };
    if (overrides && typeof overrides === 'object') {
      for (const [key, value] of Object.entries(overrides)) {
        if (value === null) delete result[key];
        else if (typeof value === 'string') result[key] = value;
      }
    }
    return result;
  }

  function cappedSink(processId, stream, cap, streaming) {
    let used = 0;
    let capped = false;
    const chunks = [];
    return {
      push(data) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        if (capped) return;
        let piece = buffer;
        if (cap !== Infinity && used + piece.length > cap) { piece = piece.subarray(0, Math.max(0, cap - used)); capped = true; }
        used += piece.length;
        if (streaming) { if (piece.length || capped) notify('command/exec/outputDelta', { processId, stream, deltaBase64: piece.toString('base64'), capReached: capped }); }
        else chunks.push(piece);
      },
      text: () => Buffer.concat(chunks).toString('utf8')
    };
  }

  async function exec(params) {
    const command = params.command;
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) throw invalid('command must be a non-empty array of strings.');
    const processId = typeof params.processId === 'string' && params.processId ? params.processId : null;
    const tty = Boolean(params.tty);
    const streamStdin = tty || Boolean(params.streamStdin);
    const streamOutput = tty || Boolean(params.streamStdoutStderr);
    if ((tty || streamStdin || streamOutput) && !processId) throw invalid('processId is required for tty, streamStdin and streamStdoutStderr.');
    if (params.size && !tty) throw invalid('size is only valid when tty is true.');
    if (params.outputBytesCap != null && params.disableOutputCap) throw invalid('outputBytesCap cannot be combined with disableOutputCap.');
    if (params.timeoutMs != null && params.disableTimeout) throw invalid('timeoutMs cannot be combined with disableTimeout.');
    if (params.sandboxPolicy || params.permissionProfile) throw invalid('sandboxPolicy and permissionProfile are not supported; OASIS uses the sandbox from its settings.');
    if (processId && processes.has(processId)) throw rpcError(-32000, 'processId is already running: ' + processId);
    if (processes.size >= MAX_PROCESSES) throw rpcError(-32000, 'Too many running processes on this connection (' + MAX_PROCESSES + ').');
    // Reserve the id before any await so follow-up write/terminate calls sent
    // right after this request find it.
    const id = processId || ('internal-' + Math.random().toString(36).slice(2));
    const record = { tty, streamStdin, child: null, pty: null, cancelled: false, pendingInput: [], kill() { record.cancelled = true; } };
    processes.set(id, record);
    try { return await execReserved(params, command, id, record, { tty, streamStdin, streamOutput }); }
    finally { processes.delete(id); }
  }

  async function execReserved(params, command, id, record, { tty, streamStdin, streamOutput }) {
    const cwd = await allowed(typeof params.cwd === 'string' && params.cwd ? path.resolve(options.cwd || process.cwd(), params.cwd) : (options.cwd || process.cwd()), 'cwd');
    const cwdInfo = await stat(cwd).catch(() => null);
    if (!cwdInfo || !cwdInfo.isDirectory()) throw invalid('cwd is not a directory: ' + cwd);
    const cap = params.disableOutputCap ? Infinity : Math.max(0, Number(params.outputBytesCap ?? DEFAULT_OUTPUT_CAP));
    const timeoutMs = params.disableTimeout ? 0 : Math.max(1, Number(params.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const sandbox = await getSandbox(cwd);
    let launched;
    try { launched = await launch(command[0], command.slice(1), sandbox, cwd, { tty }); }
    catch (error) { throw rpcError(-32000, String(error && error.message || error)); }
    if (record.cancelled) return { exitCode: 130, stdout: '', stderr: '' };
    const stdout = cappedSink(id, 'stdout', cap, streamOutput);
    const stderr = cappedSink(id, 'stderr', cap, streamOutput);
    const childEnv = commandEnv(params.env);

    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;
      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (launched.release) { try { launched.release(); } catch {} }
        // Final response follows every outputDelta already written for this connection.
        resolve({ exitCode, stdout: streamOutput ? '' : stdout.text(), stderr: streamOutput ? '' : stderr.text() });
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (launched.release) { try { launched.release(); } catch {} }
        reject(rpcError(-32000, String(error && error.message || error)));
      };
      if (tty) {
        Promise.resolve().then(loadPty).then((module) => {
          const pty = module && (typeof module.spawn === 'function' ? module : module.default);
          if (!pty || typeof pty.spawn !== 'function') throw new Error('node-pty did not expose spawn');
          const size = record.pendingSize || params.size || {};
          const term = pty.spawn(launched.command, launched.args, { name: 'xterm-256color', cols: Math.max(1, Number(size.cols) || 80), rows: Math.max(1, Number(size.rows) || 24), cwd, env: childEnv });
          record.pty = term;
          record.kill = () => { try { term.kill(); } catch {} };
          term.onData((data) => stdout.push(data));
          if (child.stdin) child.stdin.on('error', () => {});
        for (const chunk of record.pendingInput.splice(0)) if (chunk.data) term.write(chunk.data.toString('utf8'));
          if (record.cancelled) record.kill();
          term.onExit(({ exitCode }) => finish(typeof exitCode === 'number' ? exitCode : 1));
        }).catch((error) => {
          const missing = error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND');
          fail(missing ? new Error('PTY mode needs the optional node-pty component, which is not installed. Run without tty or install node-pty.') : error);
        });
      } else {
        let child;
        try {
          child = spawnProcess(launched.command, launched.args, { cwd, env: childEnv, stdio: [streamStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
        } catch (error) { fail(error); return; }
        record.child = child;
        record.kill = () => { try { signalProcessTree(child, 'SIGKILL'); } catch {} };
        for (const chunk of record.pendingInput.splice(0)) { if (chunk.data && chunk.data.length) child.stdin.write(chunk.data); if (chunk.close) child.stdin.end(); }
        if (record.cancelled) record.kill();
        child.stdout.on('data', (data) => stdout.push(data));
        child.stderr.on('data', (data) => stderr.push(data));
        child.on('error', (error) => fail(error.code === 'ENOENT' ? new Error('Command not found: ' + command[0]) : error));
        child.on('close', (code, signal) => finish(typeof code === 'number' ? code : (signal ? 128 + (({ SIGKILL: 9, SIGTERM: 15, SIGINT: 2 })[signal] || 1) : 1)));
      }
      if (timeoutMs) timer = setTimeout(() => { stderr.push(Buffer.from('\n[oasis] command timed out after ' + timeoutMs + ' ms\n')); record.kill(); }, timeoutMs);
    });
  }

  function running(processId) {
    if (typeof processId !== 'string' || !processId) throw invalid('processId is required.');
    const record = processes.get(processId);
    if (!record) throw rpcError(-32000, 'No running process with processId ' + processId + '.');
    return record;
  }

  async function execWrite(params) {
    const record = running(params.processId);
    if (!record.streamStdin) throw rpcError(-32000, 'This process was not started with streamStdin or tty.');
    const bytes = typeof params.deltaBase64 === 'string' ? Buffer.from(params.deltaBase64, 'base64') : null;
    if (!record.pty && !record.child) { record.pendingInput.push({ data: bytes, close: Boolean(params.closeStdin) }); return {}; }
    if (record.pty) { if (bytes && bytes.length) record.pty.write(bytes.toString('utf8')); return {}; }
    if (bytes && bytes.length) await new Promise((resolve) => record.child.stdin.write(bytes, resolve));
    if (params.closeStdin) record.child.stdin.end();
    return {};
  }

  async function execResize(params) {
    const record = running(params.processId);
    if (!record.tty) throw rpcError(-32000, 'Only tty processes can be resized.');
    if (!record.pty) { record.pendingSize = params.size; return {}; }
    const size = params.size || {};
    record.pty.resize(Math.max(1, Number(size.cols) || 80), Math.max(1, Number(size.rows) || 24));
    return {};
  }

  async function execTerminate(params) {
    running(params.processId).kill();
    return {};
  }

  // ---- fuzzyFileSearch ------------------------------------------------------

  const pendingSearches = new Map();
  async function fuzzyFileSearch(params) {
    const query = typeof params.query === 'string' ? params.query : '';
    if (!Array.isArray(params.roots)) throw invalid('roots must be an array of absolute paths.');
    const token = params.cancellationToken === undefined || params.cancellationToken === null ? null : String(params.cancellationToken);
    const flag = { cancelled: false };
    if (token !== null) {
      const previous = pendingSearches.get(token);
      if (previous) previous.cancelled = true;
      pendingSearches.set(token, flag);
    }
    try {
      const roots = [];
      for (const [index, raw] of params.roots.entries()) roots.push(await allowed(raw, 'roots[' + index + ']'));
      if (!query || !roots.length) return { files: [] };
      const [{ walkFiles }, { fuzzyScore }] = await Promise.all([import('./tools.mjs'), import('./completion.mjs')]);
      const files = [];
      for (const root of roots) {
        const listed = await walkFiles(root, { maxFiles: 50000, maxDepth: 24, env }).catch(() => []);
        if (flag.cancelled) return { files: [] };
        const seen = new Set();
        const consider = (rel, matchType) => {
          const hit = fuzzyScore(rel, query);
          if (hit) files.push({ root, path: rel, match_type: matchType, file_name: path.posix.basename(rel), score: hit.score, indices: hit.indices });
        };
        for (const item of listed) {
          const rel = item.relative.split(path.sep).join('/');
          consider(rel, 'file');
          const parts = rel.split('/');
          for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            if (seen.has(dir)) break;
            seen.add(dir);
            consider(dir, 'directory');
          }
        }
      }
      if (flag.cancelled) return { files: [] };
      files.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { files: files.slice(0, FUZZY_MATCH_LIMIT) };
    } finally {
      if (token !== null && pendingSearches.get(token) === flag) pendingSearches.delete(token);
    }
  }

  // ---- gitDiffToRemote -----------------------------------------------------
  // The commit nearest HEAD that some remote already has, and the diff from it
  // to the working tree, untracked files included (the patch a cloud runner
  // would need to reproduce this checkout). Read-only git plumbing; no fetch.

  function git(args, cwd, { maxBytes = 64 * 1024 * 1024, okCodes = [0] } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnProcess('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      let size = 0;
      let stderr = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 60_000);
      child.stdout.on('data', (chunk) => { size += chunk.length; if (size <= maxBytes) chunks.push(chunk); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (size > maxBytes) reject(rpcError(-32000, 'The diff is larger than ' + Math.round(maxBytes / 1048576) + ' MB.'));
        else if (okCodes.includes(code)) resolve(Buffer.concat(chunks).toString('utf8'));
        else reject(rpcError(-32000, 'git ' + args[0] + ' failed: ' + (stderr.trim().split('\n').pop() || 'exit ' + code)));
      });
    });
  }

  async function gitDiffToRemote(params) {
    const cwd = await allowed(params.cwd, 'cwd');
    const top = (await git(['rev-parse', '--show-toplevel'], cwd).catch(() => '')).trim();
    if (!top) throw rpcError(-32000, 'Not a git repository: ' + cwd);
    // The diff covers the whole repository, so its top folder must be allowed too.
    await allowed(top, 'repository root');
    const remotes = (await git(['remote'], cwd)).split('\n').map((line) => line.trim()).filter(Boolean);
    if (!remotes.length) throw rpcError(-32000, 'This repository has no remotes, so there is no remote commit to diff against.');
    // Commits on HEAD that no remote-tracking branch contains...
    const local = new Set((await git(['rev-list', 'HEAD', '--not', '--remotes'], cwd)).split('\n').filter(Boolean));
    // ...so the first commit in HEAD's history outside that set is on a remote.
    const history = (await git(['rev-list', '--topo-order', '--max-count=' + (local.size + 1000), 'HEAD'], cwd)).split('\n').filter(Boolean);
    const sha = history.find((commit) => !local.has(commit));
    if (!sha) throw rpcError(-32000, 'No commit in HEAD\'s history is on a remote yet. Push a branch or fetch first.');
    let diff = await git(['diff', '--no-textconv', '--no-ext-diff', '--binary', sha], top);
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], top)).split('\0').filter(Boolean);
    for (const file of untracked) {
      // `git diff --no-index` exits 1 when the files differ, which they always do here.
      diff += await git(['diff', '--no-textconv', '--no-ext-diff', '--binary', '--no-index', '--', '/dev/null', file], top, { okCodes: [0, 1] });
    }
    return { sha, diff };
  }

  const WRITES = new Set(['fs/writeFile', 'fs/createDirectory', 'fs/remove', 'fs/copy', 'command/exec', 'command/exec/write', 'command/exec/resize', 'command/exec/terminate']);
  const methods = {
    'fs/readFile': readFileMethod,
    'fs/writeFile': writeFileMethod,
    'fs/createDirectory': createDirectory,
    'fs/getMetadata': getMetadata,
    'fs/readDirectory': readDirectory,
    'fs/remove': remove,
    'fs/copy': copy,
    'fs/watch': watchMethod,
    'fs/unwatch': unwatch,
    'command/exec': exec,
    'command/exec/write': execWrite,
    'command/exec/resize': execResize,
    'command/exec/terminate': execTerminate,
    fuzzyFileSearch,
    gitDiffToRemote
  };

  return {
    methods: Object.keys(methods),
    has: (method) => Object.hasOwn(methods, method),
    handle: async (method, params = {}) => {
      if (options.readOnly && WRITES.has(method)) throw rpcError(-32001, method + ' is not allowed: this App Server was started read-only (plan mode).');
      return methods[method](params || {});
    },
    addRoot,
    roots: () => [...roots],
    close() {
      // Connection-scoped: processes and watches end with the connection.
      for (const record of processes.values()) record.kill();
      processes.clear();
      for (const entry of watches.values()) { entry.clear(); try { entry.watcher.close(); } catch {} }
      watches.clear();
    }
  };
}
