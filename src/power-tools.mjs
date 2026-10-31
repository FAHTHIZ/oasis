// Additional OASIS tools for deeper repository work and interactive process control:
//   grep           regex search (ripgrep when available, JS fallback) with globs, context, and modes
//   multi_edit     several exact-string edits to one file, applied atomically
//   command_output read new output from a background process
//   kill_command   stop a background process
//   list_background list background processes
//   run_shell      opt-in shell command (pipes, &&, redirects); enabled by settings or the sandbox
import { assertFileFresh, recordFileState } from './file-state.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, lstat, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { snapshotFile } from './backups.mjs';
import { relaxedReplace, closestMatchHint } from './edit-match.mjs';
import { maskedPipelineWarning } from './pipe-status.mjs';
import { assertNoNewElision, shrinkWarning, recordAndDetectCircling, testTamperWarning, combineWarnings } from './change-guard.mjs';
import { resolveWorkspacePath, walkFiles, sensitivePath, scrubEnvironment } from './tools.mjs';
import { assertSandboxAvailable, wrapCommand } from './sandbox.mjs';
import { editNotebook } from './notebook.mjs';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import { createBoundedRegexMatcher } from './safe-regex.mjs';

const MAX_TEXT_FILE = 256 * 1024;
const MAX_OUTPUT = 24 * 1024;
const MAX_BACKGROUND_BUFFER = 512 * 1024;
const MAX_BACKGROUND_PROCESSES = 8;
const MAX_BACKGROUND_HISTORY = 24;

// Defined here (not in notebook.mjs) so module cycles cannot hit it before initialization.
export const NOTEBOOK_EDIT_DEFINITION = { type: 'function', function: { name: 'notebook_edit', description: 'Edit a Jupyter notebook (.ipynb) cell by cell. edit_mode replace (default) swaps a cell\'s source and clears its outputs, insert adds a new cell after cell_id (or at the top when cell_id is omitted), delete removes a cell. Use read_file on the notebook first to see cell ids. The original file is snapshotted first.', parameters: { type: 'object', properties: {
  path: { type: 'string', description: 'Workspace-relative .ipynb path' },
  cell_id: { type: 'string', description: 'Cell id from read_file, or cell-N for the N-th cell (0-based)' },
  new_source: { type: 'string', description: 'New cell source (ignored for delete)' },
  cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Required for insert; optional for replace' },
  edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] }
}, required: ['path'] } } };

export const POWER_TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'grep', description: 'Search file contents with a regular expression (ripgrep syntax). Respects .gitignore when ripgrep is installed and always skips secret files. Use output_mode files_with_matches to find files, content to see matching lines, count for per-file counts.', parameters: { type: 'object', properties: {
    pattern: { type: 'string', description: 'Regular expression to search for' },
    path: { type: 'string', description: 'Workspace-relative file or directory to search; default .' },
    glob: { type: 'string', description: 'Only search files matching this glob, e.g. *.ts or src/**/*.mjs' },
    ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
    context: { type: 'integer', description: 'Lines of context around each match (content mode), 0-10' },
    output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default content' },
    multiline: { type: 'boolean', description: 'Allow patterns to span lines' },
    limit: { type: 'integer', description: 'Maximum result lines, 1-500; default 200' }
  }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'multi_edit', description: 'Apply several exact-string replacements to ONE existing file in order. Either every edit applies or none do. Each old_string must be unique unless replace_all is true. The original file is snapshotted first.', parameters: { type: 'object', properties: {
    path: { type: 'string', description: 'Workspace-relative file path' },
    edits: { type: 'array', maxItems: 50, items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } }
  }, required: ['path', 'edits'] } } },
  NOTEBOOK_EDIT_DEFINITION,
  { type: 'function', function: { name: 'command_output', description: 'Read new stdout/stderr from a background process started with run_command run_in_background=true, plus whether it is still running and its exit code.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Background process id' }, filter: { type: 'string', description: 'Optional regex; only return matching lines' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'kill_command', description: 'Stop a background process started by run_command run_in_background=true.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Background process id' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'list_background', description: 'List background processes in this session with their status.', parameters: { type: 'object', properties: {} } } }
];

export const SHELL_TOOL_DEFINITION = { type: 'function', function: { name: 'run_shell', description: 'Run a shell command line with pipes, &&, redirects, and globbing in the workspace. Only available when the user enabled shell access or the OS sandbox. Requires approval unless a permission rule or the sandbox allows it. Prefer run_command for single programs.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command line' }, timeoutSeconds: { type: 'integer', description: '5-600; default 120' }, run_in_background: { type: 'boolean', description: 'Start without waiting; read with command_output' }, max_seconds: { type: 'integer', description: 'With run_in_background: stop automatically after this many seconds' } }, required: ['command'] } } };

export const POWERSHELL_TOOL_DEFINITION = { type: 'function', function: { name: 'powershell', description: 'Run a PowerShell command in the workspace (pwsh 7+, or Windows PowerShell 5.1). Use it for Windows-native work, PowerShell scripts and cmdlets. Profiles are not loaded. Requires approval unless a PowerShell(...) permission rule allows it.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'PowerShell command' }, timeoutSeconds: { type: 'integer', description: '5-600; default 120' }, run_in_background: { type: 'boolean', description: 'Start without waiting; read with command_output' } }, required: ['command'] } } };
export const POWER_TOOL_NAMES = new Set(['grep', 'multi_edit', 'notebook_edit', 'command_output', 'kill_command', 'list_background', 'run_shell', 'powershell']);

// PowerShell is enabled by default on Windows (CLAUDE_CODE_USE_POWERSHELL_TOOL=0 turns it off),
// opt-in elsewhere with CLAUDE_CODE_USE_POWERSHELL_TOOL=1 (or OASIS_POWERSHELL=1) and pwsh on PATH.
export function findPowerShell(env = process.env, platform = process.platform) {
  const flag = env.CLAUDE_CODE_USE_POWERSHELL_TOOL ?? env.OASIS_POWERSHELL;
  if (flag === '0' || flag === 'false') return null;
  if (platform !== 'win32' && flag !== '1' && flag !== 'true') return null;
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'];
  for (const name of names) for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  if (platform === 'win32') {
    const fallback = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

export function powerShellLaunch(exe, command, env = process.env, platform = process.platform) {
  const args = ['-NoProfile', '-NonInteractive'];
  if (platform === 'win32' && env.CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY !== '1') args.push('-ExecutionPolicy', 'Bypass');
  // UTF-8 output on Windows PowerShell 5.1 as well.
  const prefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = \'SilentlyContinue\'; ';
  args.push('-Command', prefix + command);
  return { command: exe, args };
}

// grep, rg, findstr, git diff and friends use exit code 1 for "no match" / "differs".
export function benignExitNote(command, exitCode) {
  if (exitCode !== 1) return null;
  const first = String(command || '').trim().split(/[|;]/)[0].trim().toLowerCase();
  if (/^(grep|egrep|fgrep|rg|findstr|select-string|git\s+grep|git\s+diff|where(\.exe)?|fc(\.exe)?|diff(\.exe)?)\b/.test(first)) return 'Exit code 1 here means no matches or files differ, not a failure.';
  if (/^robocopy\b/.test(first)) return 'robocopy exit codes 1-7 report success.';
  return null;
}
export const POWER_READ_ONLY_TOOLS = new Set(['grep', 'command_output', 'list_background']);

export function commandLineText(command, args) {
  return [command, ...args.map((arg) => /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg))].join(' ');
}

// ---------------------------------------------------------------- grep
let ripgrepAvailable = null;
function hasRipgrep() {
  if (ripgrepAvailable === null) {
    try { ripgrepAvailable = spawnSync('rg', ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0; } catch { ripgrepAvailable = false; }
  }
  return ripgrepAvailable;
}

function globMatcher(glob) {
  if (!glob) return null;
  let source = '';
  const text = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '*') {
      if (text[i + 1] === '*') { i++; if (text[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*'; }
      else source += '[^/]*';
    } else if (c === '?') source += '[^/]';
    else if (c === '{') { const end = text.indexOf('}', i); if (end > i) { source += '(?:' + text.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; } else source += '\\{'; }
    else source += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  const regex = new RegExp('^' + source + '$');
  return (relative) => regex.test(relative) || (!text.includes('/') && regex.test(path.posix.basename(relative)));
}

function runRipgrep(cwd, args, signal) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    if (signal && signal.aborted) {
      resolve({ code: null, out, err: 'Search was cancelled before ripgrep started.', cancelled: true });
      return;
    }
    const child = spawn('rg', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, out, err, cancelled: cancelled || Boolean(signal && signal.aborted), timedOut });
    };
    const abort = () => {
      if (settled) return;
      cancelled = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, 30000);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    child.stdout.on('data', (chunk) => { if (out.length < 4 * 1024 * 1024) out += chunk; });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4000); });
    child.on('error', (error) => finish({ code: null, error: error.message }));
    child.on('close', (code, signalName) => finish({ code, signal: signalName }));
  });
}

export async function grepWorkspace(root, args = {}, options = {}) {
  const pattern = String(args.pattern || '');
  if (!pattern) throw new Error('grep needs a pattern.');
  if (options.signal && options.signal.aborted) {
    const error = new Error('Search was cancelled before it started.');
    error.name = 'AbortError';
    throw error;
  }
  if (pattern.length > 1000) throw new Error('Pattern is too long.');
  const mode = ['content', 'files_with_matches', 'count'].includes(args.output_mode) ? args.output_mode : 'content';
  const limit = Math.max(1, Math.min(500, Number.parseInt(args.limit, 10) || 200));
  const contextLines = Math.max(0, Math.min(10, Number.parseInt(args.context, 10) || 0));
  const target = await resolveWorkspacePath(root, args.path || '.');
  const rootReal = target.root;
  const relTarget = path.relative(rootReal, target.absolute) || '.';
  const results = [];
  let truncated = false;

  if (hasRipgrep() && !options.forceFallback) {
    const rgArgs = ['--no-heading', '--with-filename', '--color', 'never', '--max-columns', '400', '--max-columns-preview', '--hidden', '--glob', '!.git/'];
    for (const secret of ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '.npmrc', '.netrc', '.git-credentials', '.ssh/', '.aws/']) {
      // Exclusion globs only; sensitivePath() below re-checks every returned path.
      rgArgs.push('--glob', '!' + secret);
    }
    if (args.ignore_case) rgArgs.push('-i');
    if (args.multiline) rgArgs.push('-U', '--multiline-dotall');
    if (args.glob) rgArgs.push('--glob', String(args.glob));
    if (mode === 'files_with_matches') rgArgs.push('-l');
    else if (mode === 'count') rgArgs.push('-c');
    else { rgArgs.push('-n'); if (contextLines) rgArgs.push('-C', String(contextLines)); }
    rgArgs.push('-e', pattern, '--', relTarget);
    const out = await runRipgrep(rootReal, rgArgs, options.signal);
    if (out.cancelled || (options.signal && options.signal.aborted)) {
      const error = new Error('Search was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    if (out.timedOut) throw new Error('grep exceeded its 30-second time limit. Narrow the search path or pattern and retry.');
    if (out.error) throw new Error('grep could not start ripgrep: ' + out.error);
    if (out.code === 2 && !out.out) throw new Error('grep failed: ' + out.err.trim());
    for (const line of out.out.split('\n')) {
      if (!line) continue;
      const file = mode === 'files_with_matches' ? line : line.split(/[:-]\d+[:-]|:(?=\d+$)/)[0];
      if (sensitivePath(file)) continue;
      if (results.length >= limit) { truncated = true; break; }
      results.push(line.length > 500 ? line.slice(0, 500) + '…' : line);
    }
    return { pattern, mode, engine: 'ripgrep', results, count: results.length, truncated };
  }

  let matcher;
  try {
    matcher = createBoundedRegexMatcher(pattern, (args.ignore_case ? 'i' : '') + (args.multiline ? 'ms' : ''), {
      timeoutMs: options.regexTimeoutMs === undefined ? 250 : options.regexTimeoutMs
    });
    await matcher.ready;
  } catch (error) {
    if (matcher) await matcher.close().catch(() => {});
    throw new Error('Invalid regular expression: ' + error.message);
  }
  const matchGlob = globMatcher(args.glob);
  try {
    const info = await stat(target.absolute);
    const files = info.isFile() ? [{ absolute: target.absolute, relative: path.basename(target.absolute) }] : await walkFiles(target.absolute, { includeHidden: true, maxFiles: 8000, maxDepth: 14 });
    for (const file of files) {
      const relative = path.relative(rootReal, file.absolute).split(path.sep).join('/');
      if (matchGlob && !matchGlob(relative)) continue;
      let content;
      try {
        const s = await stat(file.absolute);
        if (s.size > MAX_TEXT_FILE * 4) continue;
        content = await readFile(file.absolute, 'utf8');
      } catch { continue; }
      if (content.includes('\0')) continue;
      const lines = content.split(/\r?\n/);
      let hits = 0;
      const emitted = new Set();
      for (let i = 0; i < lines.length; i++) {
        if (!await matcher.test(lines[i], { signal: options.signal })) continue;
        hits++;
        if (mode !== 'content') continue;
        for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
          if (emitted.has(j)) continue;
          emitted.add(j);
          if (results.length >= limit) { truncated = true; break; }
          results.push(relative + (j === i ? ':' : '-') + (j + 1) + (j === i ? ':' : '-') + lines[j].slice(0, 400));
        }
        if (truncated) break;
      }
      if (hits && mode === 'files_with_matches') results.push(relative);
      if (hits && mode === 'count') results.push(relative + ':' + hits);
      if (truncated || results.length >= limit) { truncated = truncated || results.length >= limit; break; }
    }
    return { pattern, mode, engine: 'builtin', results: results.slice(0, limit), count: Math.min(results.length, limit), truncated };
  } finally {
    await matcher.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- multi_edit
export async function multiEditFile(root, args = {}, context = {}) {
  if (!Array.isArray(args.edits) || !args.edits.length) throw new Error('Provide a non-empty edits array.');
  if (args.edits.length > 50) throw new Error('Use at most 50 edits per call.');
  const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
  let info;
  try { info = await lstat(target.absolute); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('That file does not exist. Use write_file to create it.');
    throw error;
  }
  if (!info.isFile()) throw new Error('That path is not a regular file.');
  if (info.size > MAX_TEXT_FILE) throw new Error('File is larger than the 256 KiB edit limit.');
  await assertFileFresh(context, target.absolute, target.relative.split(path.sep).join('/'), { exactMatch: true });
  const original = await readFile(target.absolute, 'utf8');
  if (original.includes('\0')) throw new Error('This looks like a binary file.');
  let next = original;
  let replacements = 0;
  const relaxedNotes = [];
  args.edits.forEach((edit, index) => {
    const label = 'Edit ' + (index + 1) + ': ';
    if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') throw new Error(label + 'old_string and new_string must be strings.');
    if (!edit.old_string) throw new Error(label + 'old_string must not be empty.');
    if (edit.old_string === edit.new_string) throw new Error(label + 'old_string and new_string are identical.');
    assertNoNewElision(edit.old_string, edit.new_string, target.relative.split(path.sep).join('/'));
    const count = next.split(edit.old_string).length - 1;
    if (!count) {
      const relaxed = edit.replace_all === true ? null : relaxedReplace(next, edit.old_string, edit.new_string);
      if (relaxed) {
        next = relaxed.next;
        replacements += 1;
        relaxedNotes.push('Edit ' + (index + 1) + ' matched after normalizing ' + relaxed.strategy + ' at line ' + relaxed.line);
        return;
      }
      const hint = closestMatchHint(next, edit.old_string);
      throw new Error(label + 'old_string was not found (after applying earlier edits). No edits were applied.' + (hint ? '\n' + hint : ''));
    }
    if (count > 1 && edit.replace_all !== true) throw new Error(label + 'old_string appears ' + count + ' times; add context or set replace_all. No edits were applied.');
    next = edit.replace_all === true ? next.split(edit.old_string).join(edit.new_string) : next.replace(edit.old_string, () => edit.new_string);
    replacements += edit.replace_all === true ? count : 1;
  });
  if (Buffer.byteLength(next, 'utf8') > MAX_TEXT_FILE) throw new Error('The edited file would exceed the 256 KiB limit.');
  const relative = target.relative.split(path.sep).join('/');
  if (next === original) return { path: relative, changed: false };
  await snapshotFile(target.root, target.absolute, 'before-agent-multi-edit');
  await writeFile(target.absolute, next, 'utf8');
  await recordFileState(context, target.absolute);
  const warning = combineWarnings(shrinkWarning(original, next, relative), testTamperWarning(original, next, relative), recordAndDetectCircling(context.session || context, target.absolute, original, next, relative));
  return { path: relative, changed: true, edits: args.edits.length, replacements, beforeBytes: Buffer.byteLength(original), afterBytes: Buffer.byteLength(next), backupCreated: true, ...(relaxedNotes.length ? { note: relaxedNotes.join('; ') + '.' } : {}), ...(warning ? { warning } : {}) };
}

// ---------------------------------------------------------------- background processes
export function startBackgroundProcess(registry, launch, options) {
  const entries = [...registry.values()];
  const running = entries.filter((item) => item.status === 'running');
  if (running.length >= MAX_BACKGROUND_PROCESSES) throw new Error('Too many background processes are running (' + MAX_BACKGROUND_PROCESSES + '). Stop one with kill_command first.');

  // Retain a bounded, recent history for command_output/list_background.
  // Running entries are never evicted; only the oldest completed records go.
  const history = entries
    .filter((item) => item.status !== 'running')
    .sort((a, b) => (Number(a.endedAt) || Date.parse(a.startedAt) || 0) - (Number(b.endedAt) || Date.parse(b.startedAt) || 0));
  while (history.length >= MAX_BACKGROUND_HISTORY) {
    const oldest = history.shift();
    registry.delete(oldest.id);
  }

  const id = 'bg_' + randomUUID().slice(0, 8);
  const child = spawn(launch.command, launch.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...processTreeSpawnOptions() });
  const entry = { id, command: options.display, pid: child.pid, status: 'running', exitCode: null, output: '', readOffset: 0, dropped: 0, startedAt: new Date().toISOString(), lastOutputAt: Date.now(), child, sandboxed: options.sandboxed };
  // Optional hard cap on runtime, and a one-time notice when the process goes
  // quiet for a long time (likely stuck, or waiting on input it cannot get).
  const maxSeconds = Number.parseInt(options.maxSeconds, 10);
  if (Number.isFinite(maxSeconds) && maxSeconds > 0) {
    entry.maxSeconds = Math.min(maxSeconds, 7 * 24 * 3600);
    entry.maxTimer = setTimeout(() => {
      if (entry.status !== 'running') return;
      entry.timedOut = true;
      entry.output += '\n[oasis] stopped after reaching max_seconds=' + entry.maxSeconds + '\n';
      signalProcessTree(child, 'SIGTERM');
      setTimeout(() => { if (entry.status === 'running') signalProcessTree(child, 'SIGKILL'); }, 3000).unref?.();
    }, entry.maxSeconds * 1000);
    entry.maxTimer.unref?.();
  }
  const stuckSeconds = Number.parseInt(options.stuckSeconds ?? process.env.OASIS_BACKGROUND_STUCK_SECONDS ?? 300, 10);
  if (typeof options.onStuck === 'function' && Number.isFinite(stuckSeconds) && stuckSeconds > 0 && !options.monitor) {
    entry.stuckTimer = setInterval(() => {
      if (entry.status !== 'running') { clearInterval(entry.stuckTimer); return; }
      if (entry.stuckNotified || Date.now() - entry.lastOutputAt < stuckSeconds * 1000) return;
      entry.stuckNotified = true;
      try { options.onStuck(entry, Math.round((Date.now() - entry.lastOutputAt) / 1000)); } catch {}
    }, Math.max(250, Math.min(30000, stuckSeconds * 250)));
    entry.stuckTimer.unref?.();
  }
  const append = (chunk) => {
    entry.lastOutputAt = Date.now();
    entry.output += chunk.toString();
    if (entry.output.length > MAX_BACKGROUND_BUFFER) {
      const cut = entry.output.length - MAX_BACKGROUND_BUFFER;
      entry.output = entry.output.slice(cut);
      entry.readOffset = Math.max(0, entry.readOffset - cut);
      entry.dropped += cut;
    }
  };
  // Optional line stream (stdout only) for monitors.
  let pending = '';
  const onLine = typeof options.onLine === 'function' ? options.onLine : null;
  child.stdout.on('data', (chunk) => {
    append(chunk);
    if (!onLine) return;
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    if (pending.length > 8000) { lines.push(pending); pending = ''; }
    for (const line of lines) { try { onLine(line, entry); } catch {} }
  });
  child.stderr.on('data', append);
  child.on('error', (error) => { entry.status = 'failed'; append('\n[oasis] ' + error.message + '\n'); });
  child.on('close', (code, signal) => {
    const stoppedByUser = entry.status === 'killed';
    if (entry.status === 'running') entry.status = entry.timedOut ? 'timed_out' : signal ? 'killed' : 'exited';
    entry.exitCode = code; entry.signal = signal; entry.endedAt = Date.now();
    clearTimeout(entry.maxTimer); clearInterval(entry.stuckTimer);
    if (onLine && pending) { try { onLine(pending, entry); } catch {} pending = ''; }
    if (typeof options.onExit === 'function') { try { options.onExit(entry, { stoppedByUser }); } catch {} }
  });
  if (options.monitor) entry.monitor = options.monitor;
  registry.set(id, entry);
  return { approved: true, background: true, id, pid: child.pid, command: options.display, message: 'Started in the background. Use command_output with id ' + id + ' to read output and kill_command to stop it.', ...(options.sandboxed ? { sandboxed: options.sandboxed } : {}) };
}

export function killBackgroundEntry(entry) { return killEntry(entry); }

function killEntry(entry) {
  if (!entry || entry.status !== 'running') return false;
  signalProcessTree(entry.child, 'SIGTERM');
  clearTimeout(entry.killTimer);
  entry.killTimer = setTimeout(() => {
    entry.killTimer = null;
    // Keep escalation after the leader exits: descendants may ignore SIGTERM.
    signalProcessTree(entry.child, 'SIGKILL');
  }, 1500);
  entry.killTimer.unref?.();
  entry.status = 'killed';
  return true;
}

export function killAllBackground(registry) {
  if (!registry) return 0;
  let count = 0;
  for (const entry of registry.values()) if (killEntry(entry)) count++;
  return count;
}

function describeBackground(entry) {
  const idleSeconds = entry.status === 'running' && entry.lastOutputAt ? Math.round((Date.now() - entry.lastOutputAt) / 1000) : undefined;
  return { id: entry.id, command: entry.command, pid: entry.pid, status: entry.status, exitCode: entry.exitCode, startedAt: entry.startedAt, ...(idleSeconds !== undefined ? { secondsSinceOutput: idleSeconds } : {}), ...(entry.maxSeconds ? { maxSeconds: entry.maxSeconds } : {}), ...(entry.monitor ? { monitor: entry.monitor.description } : {}) };
}

// ---------------------------------------------------------------- run_shell
const SHELL_BLOCK_PATTERNS = [
  /\bsudo\b/, /\bdoas\b/, /\bsu\s+-?\s*\w*\s*-c\b/, /\bmkfs(\.\w+)?\b/, /\bdd\s+[^|;&]*of=\/dev\//, /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$|\/\*)/i,
  /\bRemove-Item\b[^;|]*-Recurse[^;|]*\s(['"]?)([A-Za-z]:\\?|\/|~|\$HOME|\$env:USERPROFILE)\1(\s|$)/i, /\b(Format-Volume|Clear-Disk|Stop-Computer|Restart-Computer|Initialize-Disk)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, /\bshutdown\b|\breboot\b|\bpoweroff\b/, /\bchmod\s+-R\s+777\s+\//, /\bgit\s+push\b[^;&|]*(--force|-f\b)/
];

export function shellCommandBlocked(command) {
  const text = String(command || '');
  for (const pattern of SHELL_BLOCK_PATTERNS) if (pattern.test(text)) return 'This shell command matches a blocked destructive pattern (' + pattern.source + ').';
  return null;
}

async function runShell(root, args, context, flavor = 'sh') {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('Provide a shell command.');
  if (command.length > 8000 || command.includes('\0')) throw new Error('Shell command is too long or invalid.');
  const blocked = shellCommandBlocked(command);
  if (blocked) throw new Error(blocked);
  if (context.signal && context.signal.aborted) {
    return { approved: false, command, cancelled: true, message: 'Task was cancelled before shell approval or execution.' };
  }
  const requestedSandbox = context.sandbox && context.sandbox.enabled ? context.sandbox : null;
  assertSandboxAvailable(requestedSandbox);
  const sandbox = requestedSandbox;
  const autoAllowed = context.ruleAllowed || (sandbox && sandbox.autoAllowShellCommands === true) || (context.autoApprove && context.permissionMode === 'bypassPermissions');
  if (!autoAllowed) {
    const ok = context.approval && await context.approval('Run this ' + (flavor === 'powershell' ? 'PowerShell' : 'shell') + ' command in the workspace?\n  ' + command + (sandbox ? '\nIt will run inside the OS sandbox (' + sandbox.kind + ').' : '\nThis runs through a real shell WITHOUT an OS sandbox and can do anything your user account can.'), !sandbox);
    if (!ok) return { approved: false, command, message: 'Shell command was not approved. Nothing ran.' };
  }
  if (context.signal && context.signal.aborted) {
    return { approved: false, command, cancelled: true, message: 'Task was cancelled before the shell command started.' };
  }
  let shell;
  if (flavor === 'powershell') {
    const exe = context.powershell || findPowerShell(context.env || process.env);
    if (!exe) throw new Error('PowerShell was not found. Install PowerShell 7 (pwsh) and put it on PATH.');
    shell = powerShellLaunch(exe, command, context.env || process.env);
  } else shell = process.platform === 'win32' ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { command: '/bin/sh', args: ['-c', command] };
  const launch = wrapCommand(shell.command, shell.args, sandbox, root);
  const env = scrubEnvironment(context.env || process.env);
  if (args.run_in_background === true) {
    const registry = context.session && (context.session.background ||= new Map());
    if (!registry) throw new Error('Background commands are not available in this session.');
    const { backgroundExitNotifier, backgroundStuckNotifier } = await import('./monitors.mjs');
    return startBackgroundProcess(registry, launch, { cwd: root, env, display: command, sandboxed: sandbox ? sandbox.kind : null, maxSeconds: args.max_seconds, onExit: backgroundExitNotifier(context.session), onStuck: backgroundStuckNotifier(context.session) });
  }
  const timeoutSeconds = Math.max(5, Math.min(600, Number.parseInt(args.timeoutSeconds, 10) || 120));
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(launch.command, launch.args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...processTreeSpawnOptions() });
    const cleanup = () => {
      clearTimeout(timer);
      if (context.signal) context.signal.removeEventListener('abort', onAbort);
    };
    const kill = () => { signalProcessTree(child, 'SIGKILL'); };
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      kill();
    }, timeoutSeconds * 1000);
    if (context.signal) {
      if (context.signal.aborted) onAbort();
      else context.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ approved: true, command, exitCode: null, stdout, stderr, error: error.message, timedOut, cancelled });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ approved: true, command, exitCode: code, stdout, stderr: flavor === 'powershell' ? stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') : stderr, timedOut, cancelled: cancelled || Boolean(context.signal && context.signal.aborted), ...(sandbox ? { sandboxed: sandbox.kind } : {}), signal });
    });
  });
}

export async function executePowerTool(name, args, context, root) {
  switch (name) {
    case 'grep':
      return await grepWorkspace(root, args, { signal: context.signal });
    case 'multi_edit':
      return await multiEditFile(root, args, context);
    case 'notebook_edit':
      return await editNotebook(root, args);
    case 'run_shell':
      {
        const shellResult = await runShell(root, args, context);
        const pipeWarning = shellResult && typeof shellResult.exitCode === 'number' ? maskedPipelineWarning(args.command, shellResult.exitCode, process.platform === 'win32' ? 'cmd' : 'sh') : '';
        return pipeWarning ? { ...shellResult, exitCodeWarning: pipeWarning } : shellResult;
      }
    case 'powershell':
      return await runShell(root, args, context, 'powershell');
    case 'list_background': {
      const registry = context.session && context.session.background;
      return { processes: registry ? [...registry.values()].map(describeBackground) : [] };
    }
    case 'command_output': {
      const entry = context.session && context.session.background && context.session.background.get(String(args.id || ''));
      if (!entry) throw new Error('No background process with that id. Use list_background.');
      let text = entry.output.slice(entry.readOffset);
      if (args.filter) {
        let matcher;
        try {
          matcher = createBoundedRegexMatcher(String(args.filter), '', { timeoutMs: 250 });
          await matcher.ready;
        } catch (error) {
          if (matcher) await matcher.close().catch(() => {});
          throw new Error('Invalid filter: ' + error.message);
        }
        try {
          const filtered = [];
          for (const line of text.split('\n')) if (await matcher.test(line, { signal: context.signal })) filtered.push(line);
          text = filtered.join('\n');
        } finally {
          await matcher.close().catch(() => {});
        }
      }
      const truncated = text.length > MAX_OUTPUT;
      entry.readOffset = entry.output.length;
      return { ...describeBackground(entry), output: truncated ? text.slice(-MAX_OUTPUT) : text, truncated, droppedBytes: entry.dropped };
    }
    case 'kill_command': {
      const entry = context.session && context.session.background && context.session.background.get(String(args.id || ''));
      if (!entry) throw new Error('No background process with that id.');
      const killed = killEntry(entry);
      return { ...describeBackground(entry), killed };
    }
    default:
      throw new Error('Unknown power tool: ' + name);
  }
}
