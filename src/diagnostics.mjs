// Code diagnostics: run the project's own type checkers and linters and return
// structured problems (file, line, column, severity, message) that help users
// inspect the project state after changes.
//
// Checkers are detected from project files:
//   typescript  tsconfig.json + tsc           tsc --noEmit --pretty false
//   eslint      eslint config + eslint        eslint --format unix
//   ruff        Python files + ruff           ruff check --output-format concise --no-fix
//   mypy        mypy config + mypy            mypy --show-column-numbers --no-error-summary
//   pyright     pyrightconfig.json + pyright  pyright
//   go          go.mod + go                   go vet ./...
//   cargo       Cargo.toml + cargo            cargo check --message-format short
//   node        built-in syntax check for .js/.mjs/.cjs (node --check, never executes code);
//               skipped when ESLint is available
//   json        built-in JSON parse check
//
// External checkers go through runWorkspaceCommand, so approval prompts, permission
// rules, the OS sandbox and secret-environment scrubbing all still apply. The two
// built-in checkers only parse files and need no approval.
import { spawn, spawnSync } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import { readFile, stat, access } from 'node:fs/promises';
import path from 'node:path';
// tools.mjs imports this module, so its helpers are loaded lazily to avoid a cycle.
const workspaceTools = () => import('./tools.mjs');

export const CHECKERS = ['typescript', 'eslint', 'ruff', 'mypy', 'pyright', 'go', 'cargo', 'node', 'json'];
const MAX_DIAGNOSTICS = 200;
const MAX_BUILTIN_FILES = 60;
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);

export const DIAGNOSTICS_TOOL_DEFINITION = { type: 'function', function: { name: 'diagnostics', description: 'Run the project\'s type checkers and linters (TypeScript, ESLint, Ruff, mypy, Pyright, go vet, cargo check) plus built-in JavaScript and JSON syntax checks, and return structured problems with file, line, column, severity and message. Use after editing code to catch errors before running tests. checker auto (default) runs every checker the project is set up for. paths limits results (and built-in checks) to specific files or folders; without paths the built-in checks cover files changed in Git. External checkers need the same approval as run_command.', parameters: { type: 'object', properties: {
  checker: { type: 'string', enum: ['auto', ...CHECKERS], description: 'Which checker to run; default auto' },
  paths: { type: 'array', maxItems: 50, items: { type: 'string' }, description: 'Optional workspace-relative files or folders to focus on' },
  timeoutSeconds: { type: 'integer', description: 'Per-checker timeout, 10-600; default 180' }
}, required: [] } } };

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

const pathCache = new Map();
function onPath(command, env) {
  const key = command + '\0' + (env.PATH || '');
  if (!pathCache.has(key)) {
    let found = false;
    try {
      const probe = process.platform === 'win32' ? spawnSync('where', [command], { stdio: 'ignore', timeout: 3000, env }) : spawnSync('sh', ['-c', 'command -v "$0"', command], { stdio: 'ignore', timeout: 3000, env });
      found = probe.status === 0;
    } catch { found = false; }
    pathCache.set(key, found);
  }
  return pathCache.get(key);
}

// Prefer the project-local binary (node_modules/.bin, .venv/bin) over a global one.
export async function findBinary(root, name, env, { node = false, python = false } = {}) {
  const candidates = [];
  if (node) candidates.push(path.join('node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : '')));
  if (python) candidates.push(path.join('.venv', process.platform === 'win32' ? 'Scripts' : 'bin', name + (process.platform === 'win32' ? '.exe' : '')));
  for (const relative of candidates) {
    if (await exists(path.join(root, relative))) return '.' + path.sep + relative;
  }
  return onPath(name, env) ? name : null;
}

async function anyExists(root, names) {
  for (const name of names) if (await exists(path.join(root, name))) return name;
  return null;
}

async function fileContains(root, name, needle) {
  try { return (await readFile(path.join(root, name), 'utf8')).includes(needle); } catch { return false; }
}

// Returns the checkers this project is configured for, with the command to run.
export async function detectCheckers(root, { env = process.env, paths = [] } = {}) {
  const found = [];
  if (await exists(path.join(root, 'tsconfig.json'))) {
    const bin = await findBinary(root, 'tsc', env, { node: true });
    found.push(bin ? { name: 'typescript', command: bin, args: ['--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'] } : { name: 'typescript', missing: 'tsc is not installed (npm install -D typescript)' });
  }
  const eslintConfig = await anyExists(root, ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml']) ||
    (await fileContains(root, 'package.json', '"eslintConfig"') ? 'package.json' : null);
  if (eslintConfig) {
    const bin = await findBinary(root, 'eslint', env, { node: true });
    found.push(bin ? { name: 'eslint', command: bin, args: ['--format', 'unix', '--no-color', ...(paths.length ? paths : ['.'])] } : { name: 'eslint', missing: 'eslint is not installed (npm install -D eslint)' });
  }
  const pythonProject = await anyExists(root, ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'ruff.toml', '.ruff.toml']);
  if (pythonProject) {
    const ruff = await findBinary(root, 'ruff', env, { python: true });
    if (ruff) found.push({ name: 'ruff', command: ruff, args: ['check', '--output-format', 'concise', '--no-fix', '--quiet', ...(paths.length ? paths : ['.'])] });
    const mypyConfigured = await anyExists(root, ['mypy.ini', '.mypy.ini']) || await fileContains(root, 'pyproject.toml', '[tool.mypy]') || await fileContains(root, 'setup.cfg', '[mypy');
    if (mypyConfigured) {
      const mypy = await findBinary(root, 'mypy', env, { python: true });
      found.push(mypy ? { name: 'mypy', command: mypy, args: ['--show-column-numbers', '--no-error-summary', '--no-color-output', ...(paths.length ? paths : ['.'])] } : { name: 'mypy', missing: 'mypy is configured but not installed' });
    }
    const pyrightConfigured = await exists(path.join(root, 'pyrightconfig.json')) || await fileContains(root, 'pyproject.toml', '[tool.pyright]');
    if (pyrightConfigured) {
      const pyright = await findBinary(root, 'pyright', env, { node: true, python: true });
      found.push(pyright ? { name: 'pyright', command: pyright, args: [...paths] } : { name: 'pyright', missing: 'pyright is configured but not installed' });
    }
  }
  if (await exists(path.join(root, 'go.mod'))) {
    found.push(onPath('go', env) ? { name: 'go', command: 'go', args: ['vet', './...'] } : { name: 'go', missing: 'the go toolchain is not on PATH' });
  }
  if (await exists(path.join(root, 'Cargo.toml'))) {
    found.push(onPath('cargo', env) ? { name: 'cargo', command: 'cargo', args: ['check', '--message-format', 'short', '--quiet'] } : { name: 'cargo', missing: 'cargo is not on PATH' });
  }
  // Built-in checks always apply; they decide per file whether there is anything to do.
  // ESLint already reports JavaScript parse errors, so the node syntax check only fills the gap.
  if (!found.some((checker) => checker.name === 'eslint' && !checker.missing)) found.push({ name: 'node', builtin: true });
  found.push({ name: 'json', builtin: true });
  return found;
}

// ---------------------------------------------------------------- parsing
function severityOf(text) {
  const value = String(text || '').toLowerCase();
  if (/warn/.test(value)) return 'warning';
  if (/note|info|hint/.test(value)) return 'info';
  return 'error';
}

function normalizeFile(root, file) {
  let value = String(file || '').trim();
  if (!value) return value;
  if (path.isAbsolute(value)) {
    const relative = path.relative(root, value);
    if (!relative.startsWith('..')) value = relative;
  }
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

// Parse checker output into diagnostics. Exported for tests.
export function parseDiagnostics(checker, output, root = '.') {
  const results = [];
  const push = (file, line, column, severity, message, code) => {
    if (!file || !message) return;
    results.push({ file: normalizeFile(root, file), line: Number(line) || 1, column: Number(column) || 1, severity, message: String(message).trim().slice(0, 600), ...(code ? { code } : {}), source: checker });
  };
  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '');
    let m;
    switch (checker) {
      case 'typescript':
        // src/a.ts(3,5): error TS2322: Type 'string' is not assignable ...
        if ((m = line.match(/^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/))) push(m[1], m[2], m[3], severityOf(m[4]), m[6], m[5]);
        break;
      case 'eslint':
        // /abs/src/a.js:3:5: 'x' is defined but never used. [Error/no-unused-vars]
        if ((m = line.match(/^(.+?):(\d+):(\d+): (.*?)(?: \[(Error|Warning)(?:\/([^\]]+))?\])?$/))) push(m[1], m[2], m[3], severityOf(m[5] || 'error'), m[4], m[6]);
        break;
      case 'ruff':
        // src/a.py:3:5: F401 [*] `os` imported but unused
        if ((m = line.match(/^(.+?):(\d+):(\d+): ([A-Z]+\d+)\s+(?:\[\*\]\s+)?(.*)$/))) push(m[1], m[2], m[3], 'error', m[5], m[4]);
        else if ((m = line.match(/^(.+?):(\d+):(\d+): (SyntaxError|invalid-syntax):?\s*(.*)$/))) push(m[1], m[2], m[3], 'error', m[5] || m[4], 'syntax');
        break;
      case 'mypy':
        // src/a.py:3:5: error: Incompatible types ...  [assignment]
        if ((m = line.match(/^(.+?):(\d+):(?:(\d+):)? (error|warning|note): (.*?)(?:\s+\[([a-z-]+)\])?$/))) push(m[1], m[2], m[3], severityOf(m[4]), m[5], m[6]);
        break;
      case 'pyright':
        //   /abs/src/a.py:3:5 - error: "x" is not defined (reportUndefinedVariable)
        if ((m = line.match(/^\s*(.+?):(\d+):(\d+) - (error|warning|information): (.*?)(?: \((report\w+)\))?$/))) push(m[1], m[2], m[3], severityOf(m[4]), m[5], m[6]);
        break;
      case 'go':
        // ./main.go:3:5: undefined: x   or   vet: ./main.go:3:5: ...
        if ((m = line.match(/^(?:vet: )?(.+?\.go):(\d+):(\d+): (.*)$/))) push(m[1], m[2], m[3], 'error', m[4]);
        break;
      case 'cargo':
        // src/main.rs:3:5: error[E0308]: mismatched types
        if ((m = line.match(/^(.+?\.rs):(\d+):(\d+): (error|warning)(?:\[(\w+)\])?: (.*)$/))) push(m[1], m[2], m[3], severityOf(m[4]), m[6], m[5]);
        break;
      default:
        break;
    }
  }
  return results;
}

// ---------------------------------------------------------------- built-in checks
async function changedFiles(root) {
  return await new Promise((resolve) => {
    let out = '';
    const child = spawn('git', ['status', '--porcelain', '--untracked-files=all', '-z'], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...processTreeSpawnOptions() });
    const timer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 10000);
    child.stdout.on('data', (chunk) => { if (out.length < 1024 * 1024) out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const files = [];
      const entries = out.split('\0');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) continue;
        const status = entry.slice(0, 2);
        if (status.includes('D')) continue;
        files.push(entry.slice(3));
        if (status.includes('R') || status.includes('C')) i++; // skip the rename source
      }
      resolve(files);
    });
  });
}

async function expandPaths(root, paths) {
  const { walkFiles, resolveWorkspacePath } = await workspaceTools();
  const files = [];
  for (const item of paths) {
    const target = await resolveWorkspacePath(root, item);
    const info = await stat(target.absolute).catch(() => null);
    if (!info) continue;
    if (info.isFile()) files.push(path.relative(target.root, target.absolute));
    else if (info.isDirectory()) {
      for (const file of await walkFiles(target.absolute, { maxFiles: 2000, maxDepth: 12 })) files.push(path.relative(target.root, file.absolute));
    }
    if (files.length > 2000) break;
  }
  return files.map((file) => file.split(path.sep).join('/'));
}

function nodeCheck(absolute, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ code: null, stderr: '', cancelled: true });
      return;
    }
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let timer = null;
    let child = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, cancelled: cancelled || Boolean(signal && signal.aborted), timedOut });
    };
    const abort = () => {
      if (settled) return;
      cancelled = true;
      if (child) signalProcessTree(child, 'SIGKILL');
    };
    try {
      child = spawn(process.execPath, ['--check', absolute], { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH || '' }, ...processTreeSpawnOptions() });
    } catch (error) {
      finish({ code: null, stderr: error.message });
      return;
    }
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      signalProcessTree(child, 'SIGKILL');
    }, 15000);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', (error) => finish({ code: null, stderr: error.message }));
    child.on('close', (code) => finish({ code, stderr }));
  });
}
}

// node --check prints "file:LINE\n<source>\n   ^^^\n\nSyntaxError: message".
export function parseNodeCheck(relative, stderr) {
  const text = String(stderr || '');
  const lineMatch = text.match(/:(\d+)\r?\n/);
  const caret = text.match(/\n(\s*)\^+/);
  const message = (text.match(/^(\w*Error: .*)$/m) || [null, text.trim().split('\n').pop() || 'Syntax error'])[1];
  return { file: relative, line: lineMatch ? Number(lineMatch[1]) : 1, column: caret ? caret[1].length + 1 : 1, severity: 'error', message: message.trim().slice(0, 600), source: 'node' };
}

export function jsonDiagnostic(relative, content) {
  try { JSON.parse(content); return null; } catch (error) {
    const message = String(error.message || error);
    let line = 1;
    let column = 1;
    const lc = message.match(/line (\d+) column (\d+)/);
    const pos = message.match(/position (\d+)/);
    if (lc) { line = Number(lc[1]); column = Number(lc[2]); }
    else if (pos) {
      const before = content.slice(0, Number(pos[1]));
      line = before.split('\n').length;
      column = before.length - before.lastIndexOf('\n');
    }
    return { file: relative, line, column, severity: 'error', message: message.replace(/^JSON\.parse: /, '').slice(0, 600), source: 'json' };
  }
}

const JSONC_FILES = /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|\.eslintrc\.json|devcontainer\.json|settings\.json|launch\.json|tasks\.json|extensions\.json)$/;

async function runBuiltin(name, root, files, signal) {
  const { sensitivePath } = await workspaceTools();
  const diagnostics = [];
  const timedOutFiles = [];
  let checked = 0;
  const wanted = files.filter((file) => {
    if (sensitivePath(file) || /(^|\/)(node_modules|\.git|dist|build|coverage)\//.test(file)) return false;
    const ext = path.extname(file).toLowerCase();
    return name === 'node' ? JS_EXT.has(ext) : ext === '.json' && !JSONC_FILES.test(file);
  });
  for (const relative of wanted.slice(0, MAX_BUILTIN_FILES)) {
    if (signal && signal.aborted) return { diagnostics, checked, timedOutFiles, cancelled: true, skippedFiles: Math.max(0, wanted.length - MAX_BUILTIN_FILES) };
    const absolute = path.join(root, relative);
    const info = await stat(absolute).catch(() => null);
    if (!info || !info.isFile() || info.size > 2 * 1024 * 1024) continue;
    if (name === 'node') {
      const out = await nodeCheck(absolute, signal);
      if (out.cancelled || (signal && signal.aborted)) {
        return { diagnostics, checked, timedOutFiles, cancelled: true, skippedFiles: Math.max(0, wanted.length - MAX_BUILTIN_FILES) };
      }
      checked++;
      if (out.timedOut) timedOutFiles.push(relative);
      else if (out.code !== 0 && out.code !== null) diagnostics.push(parseNodeCheck(relative, out.stderr));
      else if (out.code === null && out.stderr) diagnostics.push({ file: relative, line: 1, column: 1, severity: 'error', message: ('Node syntax checker could not start: ' + out.stderr).slice(0, 600), source: 'node' });
    } else {
      const content = await readFile(absolute, 'utf8').catch(() => null);
      if (content === null) continue;
      checked++;
      const problem = jsonDiagnostic(relative, content.replace(/^\uFEFF/, ''));
      if (problem) diagnostics.push(problem);
    }
  }
  return { diagnostics, checked, timedOutFiles, cancelled: Boolean(signal && signal.aborted), skippedFiles: Math.max(0, wanted.length - MAX_BUILTIN_FILES) };
}

function underPaths(file, paths) {
  if (!paths.length) return true;
  return paths.some((item) => {
    const prefix = item.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return !prefix || prefix === '.' || file === prefix || file.startsWith(prefix + '/');
  });
}

// ---------------------------------------------------------------- entry point
export async function runDiagnostics(root, args = {}, options = {}) {
  const { runWorkspaceCommand, resolveWorkspacePath } = await workspaceTools();
  const env = options.env || process.env;
  const requested = args.checker && args.checker !== 'auto' ? String(args.checker) : 'auto';
  if (requested !== 'auto' && !CHECKERS.includes(requested)) throw new Error('Unknown checker ' + requested + '. Use one of: auto, ' + CHECKERS.join(', ') + '.');
  const rawPaths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean).slice(0, 50) : [];
  const paths = [];
  for (const item of rawPaths) {
    const target = await resolveWorkspacePath(root, item);
    paths.push((path.relative(target.root, target.absolute) || '.').split(path.sep).join('/'));
  }
  const workspace = (await resolveWorkspacePath(root, '.')).root;
  const timeoutSeconds = Math.max(10, Math.min(600, Number.parseInt(args.timeoutSeconds, 10) || 180));

  let checkers = await detectCheckers(workspace, { env, paths });
  if (requested !== 'auto') {
    checkers = checkers.filter((checker) => checker.name === requested);
    if (!checkers.length) {
      if (requested === 'node' || requested === 'json') checkers = [{ name: requested, builtin: true }];
      else return { checker: requested, ran: [], diagnostics: [], summary: { errors: 0, warnings: 0, total: 0 }, message: 'This project is not set up for ' + requested + ' (no matching config file was found).' };
    }
  }

  let builtinFiles = null;
  const ran = [];
  let diagnostics = [];
  for (const checker of checkers) {
    if (options.signal && options.signal.aborted) break;
    if (checker.missing) { ran.push({ name: checker.name, skipped: checker.missing }); continue; }
    if (checker.builtin) {
      if (builtinFiles === null) builtinFiles = paths.length ? await expandPaths(workspace, paths) : (await changedFiles(workspace) || []);
      const out = await runBuiltin(checker.name, workspace, builtinFiles, options.signal);
      if (!out.checked) continue;
      ran.push({ name: checker.name, builtin: true, filesChecked: out.checked, ...(out.skippedFiles ? { filesSkipped: out.skippedFiles } : {}), problems: out.diagnostics.length });
      diagnostics.push(...out.diagnostics);
      continue;
    }
    const result = await runWorkspaceCommand(workspace, checker.command, checker.args, {
      approval: options.approval,
      autoApprove: Boolean(options.autoApprove),
      ruleAllowed: Boolean(options.ruleAllowed),
      timeoutSeconds,
      env,
      signal: options.signal,
      sandbox: options.sandbox
    });
    const commandText = [checker.command, ...checker.args].join(' ');
    if (result.approved === false) { ran.push({ name: checker.name, command: commandText, skipped: result.message || 'Not approved.' }); continue; }
    const found = parseDiagnostics(checker.name, (result.stdout || '') + '\n' + (result.stderr || ''), workspace);
    const entry = { name: checker.name, command: commandText, exitCode: result.exitCode, problems: found.length };
    if (result.timedOut) entry.timedOut = true;
    if (result.error) entry.error = result.error;
    // A failing checker that produced nothing we could parse: surface the raw tail.
    if (!found.length && result.exitCode && result.exitCode !== 0) entry.output = ((result.stderr || '') + '\n' + (result.stdout || '')).trim().slice(-2000);
    ran.push(entry);
    diagnostics.push(...found);
  }

  diagnostics = diagnostics.filter((item) => underPaths(item.file, paths));
  const seen = new Set();
  diagnostics = diagnostics.filter((item) => {
    const key = [item.file, item.line, item.column, item.message].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rank = { error: 0, warning: 1, info: 2 };
  diagnostics.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  const summary = {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    total: diagnostics.length
  };
  const truncated = diagnostics.length > MAX_DIAGNOSTICS;
  return {
    checker: requested,
    ...(paths.length ? { paths } : {}),
    ran,
    summary,
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    ...(truncated ? { truncated: true } : {}),
    message: !ran.length ? 'No checkers applied: no type checker or linter config was found and there were no changed .js/.json files. Pass paths to check specific files.'
      : summary.total ? summary.errors + ' error(s) and ' + summary.warnings + ' warning(s) found.' : 'No problems found.'
  };
}

// Text rendering for the CLI (`oasis diagnostics`) and the /diagnostics command.
export function formatDiagnostics(result) {
  const lines = [];
  for (const entry of result.ran || []) {
    const label = entry.builtin ? entry.name + ' (built-in, ' + entry.filesChecked + ' file' + (entry.filesChecked === 1 ? '' : 's') + ')' : entry.name + (entry.command ? ' — ' + entry.command : '');
    lines.push((entry.skipped ? '  skipped ' : '  ran     ') + label + (entry.skipped ? ': ' + entry.skipped : entry.timedOut ? ' (timed out)' : ''));
    if (entry.output) lines.push(entry.output.split('\n').map((line) => '      ' + line).join('\n'));
  }
  for (const item of result.diagnostics || []) {
    lines.push(item.file + ':' + item.line + ':' + item.column + ' ' + item.severity + (item.code ? ' ' + item.code : '') + ' ' + item.message + ' [' + item.source + ']');
  }
  if (result.truncated) lines.push('… more problems were omitted.');
  lines.push(result.message);
  return lines.join('\n');
}
