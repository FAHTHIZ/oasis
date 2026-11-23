// minimize_repro: shrink an input that triggers a bug to the smallest input
// that still triggers it.
//
// A 3,000-line config, log, fixture or source file that crashes a parser is a
// poor bug report and a slow test. Delta debugging (Zeller's ddmin) removes
// chunks of the file, keeps every removal after which the command still fails
// the same way, and refines the chunk size until no single line (or
// character) can go. The result is usually a handful of lines that point
// straight at the cause, and it makes a good regression test.
//
// "Fails the same way" means: the same exit code as the original failure (or
// a timeout again, when the original timed out), and either output_pattern
// matches, or the original's key error line (masked for numbers, paths and
// times) still appears. Without that second check, ddmin happily shrinks to
// an input that fails for a different, trivial reason, such as a syntax
// error.
//
// The file is edited in place because the command reads it from there. The
// original bytes and modification time are restored after the run, on
// cancellation and at process exit; a journal under .oasis/minimize/ restores
// it on the next run if OASIS was killed. The minimized input is written to a
// new file (default <name>.min<ext>), never over the original.
//
// Every run goes through runWorkspaceCommand (permission rules, risk
// analysis, the OS sandbox, cancellation). One approval covers the search.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeFailure } from './flaky-check.mjs';
import { splitSimpleCommandLine } from './tool-aliases.mjs';

export const MINIMIZE_REPRO_TOOL_DEFINITION = { type: 'function', function: {
  name: 'minimize_repro',
  description: 'Shrink an input file that makes a command fail (a crashing fixture, config, log, query or source file) to the smallest version that still fails the same way, by delta debugging: removes chunks of lines (or characters), keeps each removal that still reproduces the failure, and stops when nothing more can go. Same way = same exit code plus output_pattern, or the original key error line. The original file is restored afterwards; the minimized input is written to a new file. Use it when a bug only shows on a large input, before reading the whole input or code to guess the cause, and to turn the minimized input into a regression test.',
  parameters: { type: 'object', properties: {
    file: { type: 'string', description: 'The input file the command reads, relative to the workspace' },
    command: { type: 'string', description: 'The command that fails on that file, as one simple command line (e.g. "node parse.mjs data/big.json", "python -m mytool tests/fixtures/crash.yaml")' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments, when command is only the program name' },
    output_pattern: { type: 'string', description: 'Regular expression the failing output must keep matching (e.g. "RangeError: Invalid array length"). Default: the key error line of the original failure.' },
    granularity: { type: 'string', enum: ['lines', 'chars', 'auto'], description: 'Remove whole lines (default), characters, or lines and then characters (auto, for results under 4,000 characters)' },
    output: { type: 'string', description: 'Where to write the minimized input; default <name>.min<ext> next to the file' },
    max_runs: { type: 'integer', description: '5-500; default 150' },
    timeout_seconds: { type: 'integer', description: 'Per run, 2-300; default 60' }
  }, required: ['file', 'command'], additionalProperties: false } } };

const MAX_BYTES = 2 * 1024 * 1024;
const KEY_LINE = /\b(?:error|exception|panic|assert\w*|fail\w*|traceback|fatal|segmentation fault|abort\w*|invalid|unexpected)\b/i;

// ---------------------------------------------------------------------------
// ddmin

/** Splits text into units that join back to the same text. */
export function splitUnits(text, granularity) {
  if (granularity === 'chars') return Array.from(text);
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function chunksOf(units, n) {
  const size = Math.ceil(units.length / n);
  const out = [];
  for (let start = 0; start < units.length; start += size) out.push(units.slice(start, start + size));
  return out;
}

/**
 * Zeller's ddmin over an array. test(units) resolves true when the units
 * still reproduce the failure. Returns the smallest array found within
 * budget() and whether it is 1-minimal (no single unit can be removed).
 */
export async function ddmin(units, test, budget = () => true) {
  let current = units;
  let n = 2;
  let minimal = false;
  while (current.length >= 2 && budget()) {
    const chunks = chunksOf(current, n);
    let reduced = false;
    for (const chunk of chunks) {
      if (!budget()) break;
      if (chunk.length < current.length && await test(chunk)) { current = chunk; n = 2; reduced = true; break; }
    }
    if (!reduced && chunks.length > 2) {
      for (let index = 0; index < chunks.length; index += 1) {
        if (!budget()) break;
        const complement = chunks.flatMap((chunk, other) => other === index ? [] : chunk);
        if (await test(complement)) { current = complement; n = Math.max(n - 1, 2); reduced = true; break; }
      }
    }
    if (!reduced) {
      if (n >= current.length) { minimal = budget(); break; }
      n = Math.min(current.length, n * 2);
    }
  }
  if (current.length < 2) minimal = true;
  return { units: current, minimal };
}

// ---------------------------------------------------------------------------
// Restore safety

function journalPath(root) { return path.join(root, '.oasis', 'minimize', 'journal.json'); }
const LIVE = new Map();
let exitHandlerInstalled = false;
function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once('exit', () => {
    for (const [root, entry] of LIVE) {
      restoreSync(entry);
      try { rmSync(journalPath(root), { force: true }); } catch { /* best effort */ }
    }
  });
}

function restoreSync(entry) {
  try {
    writeFileSync(entry.absolute, entry.content);
    if (entry.mtimeMs) utimesSync(entry.absolute, (entry.atimeMs || entry.mtimeMs) / 1000, entry.mtimeMs / 1000);
  } catch { /* best effort */ }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Restores a file a killed run left shrunk. Returns its path, or ''. */
export async function restorePendingMinimize(root) {
  root = path.resolve(root);
  const file = journalPath(root);
  if (!existsSync(file) || LIVE.has(root)) return '';
  let journal;
  try { journal = JSON.parse(readFileSync(file, 'utf8')); } catch { await rm(file, { force: true }); return ''; }
  if (journal.pid !== process.pid && processAlive(journal.pid)) return '';
  const absolute = path.resolve(root, String(journal.relative || ''));
  if (absolute.startsWith(root + path.sep) && typeof journal.content === 'string') {
    restoreSync({ absolute, content: Buffer.from(journal.content, 'base64'), mtimeMs: Number(journal.mtime) || null, atimeMs: Number(journal.atime) || null });
  }
  await rm(file, { force: true });
  return String(journal.relative || '');
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function tail(text, limit = 500) {
  const value = String(text || '').trim();
  return value.length > limit ? '…' + value.slice(-limit) : value;
}

/** The line that names the original failure, masked for numbers and paths. */
export function keyErrorLine(output) {
  const lines = String(output || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((item) => KEY_LINE.test(item) && !/^at\s|^File "/.test(item));
  return line ? normalizeFailure(line) : '';
}

// ---------------------------------------------------------------------------
// The tool

export async function runMinimizeRepro(root, args = {}, options = {}) {
  root = path.resolve(root);
  const { runWorkspaceCommand } = options.tools || await import('./tools.mjs');
  const argv = Array.isArray(args.args) && args.args.length ? [String(args.command || ''), ...args.args.map(String)] : splitSimpleCommandLine(args.command);
  if (!argv || !argv[0]) throw new Error('minimize_repro needs one simple command line without pipes, && or redirects, or command plus args.');
  const absolute = path.resolve(root, String(args.file || ''));
  if (!args.file || !inside(root, absolute)) throw new Error('file must be a path inside the workspace.');
  if (!existsSync(absolute)) return { ok: false, message: 'There is no file ' + args.file + '.' };
  let real;
  try { real = realpathSync(absolute); } catch { real = absolute; }
  if (!inside(realpathSync(root), real)) throw new Error('file resolves outside the workspace (a symlink); refusing to edit it.');
  const output = path.resolve(root, String(args.output || (() => { const ext = path.extname(args.file); return args.file.slice(0, args.file.length - ext.length) + '.min' + ext; })()));
  if (!inside(root, output)) throw new Error('output must be a path inside the workspace.');
  if (output === absolute) throw new Error('output must differ from file; the original is always kept.');
  // The input is rewritten many times and the output written, and both are
  // shown to the model, so they get the same limits as the file tools: no
  // secrets (.env, keys), no protected config (.git/hooks, settings, MCP), and
  // no output through a symlink to somewhere else.
  const { sensitivePath } = await import('./tools.mjs');
  const { protectedConfigTarget, protectedEditsAllowed } = await import('./protected-paths.mjs');
  const env = options.env || process.env;
  for (const [label, target] of [['file', absolute], ['file', real], ['output', output]]) {
    const rel = path.relative(root, target).split(path.sep).join('/');
    if (sensitivePath(rel)) throw new Error(label + ' ' + rel + ' is a protected secret file; minimize_repro does not read or write it.');
    const hit = protectedEditsAllowed(env) ? null : await protectedConfigTarget(root, target).catch(() => null);
    if (hit) throw new Error(label + ' ' + hit.path + ' is protected configuration (' + hit.reason + '); minimize_repro does not change it.');
  }
  {
    // lstat, not exists: a dangling symlink would let the write create its target.
    let link = null;
    try { link = lstatSync(output); } catch { link = null; }
    if (link && link.isSymbolicLink()) throw new Error('output ' + path.relative(root, output) + ' is a symlink; refusing to write through it.');
    let cursor = path.dirname(output);
    while (!existsSync(cursor) && path.dirname(cursor) !== cursor) cursor = path.dirname(cursor);
    let realCursor;
    try { realCursor = realpathSync(cursor); } catch { realCursor = cursor; }
    const realRoot = realpathSync(root);
    if (realCursor !== realRoot && !inside(realRoot, realCursor)) throw new Error('output resolves outside the workspace (a symlink); refusing to write it.');
  }
  let pattern = null;
  if (args.output_pattern) {
    if (String(args.output_pattern).length > 300) throw new Error('output_pattern is too long (300 characters at most).');
    try { pattern = new RegExp(String(args.output_pattern), 'm'); } catch (error) { throw new Error('output_pattern is not a valid regular expression: ' + error.message); }
  }
  const granularity = ['lines', 'chars', 'auto'].includes(args.granularity) ? args.granularity : 'lines';
  const maxRuns = Math.max(5, Math.min(500, Number.parseInt(args.max_runs, 10) || 150));
  const timeoutSeconds = Math.max(2, Math.min(300, Number.parseInt(args.timeout_seconds, 10) || 60));
  const relative = path.relative(root, absolute);
  const commandText = argv.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');

  await restorePendingMinimize(root);
  if (LIVE.has(root)) return { ok: false, message: 'Another minimize_repro is running in this workspace; wait for it to finish.' };
  try {
    const journal = JSON.parse(readFileSync(journalPath(root), 'utf8'));
    if (journal.pid !== process.pid && processAlive(journal.pid)) return { ok: false, message: 'Another OASIS process (pid ' + journal.pid + ') is minimizing a file in this workspace.' };
  } catch { /* no journal */ }

  const info = await stat(absolute);
  if (!info.isFile()) return { ok: false, message: args.file + ' is not a regular file.' };
  if (info.size > MAX_BYTES) return { ok: false, message: args.file + ' is larger than 2 MB; cut it down by hand first, or minimize a slice of it.' };
  const original = await readFile(absolute);
  if (original.includes(0)) return { ok: false, message: args.file + ' looks binary; minimize_repro works on text files.' };
  const text = original.toString('utf8');

  const hold = options.injectionHold || '';
  if (hold || (!options.autoApprove && !options.ruleAllowed)) {
    const ok = options.approval && await options.approval('Shrink ' + relative + ' while this command keeps failing?\n  ' + commandText + '\nruns up to ' + maxRuns + ' times, rewriting ' + relative + ' between runs; it is restored afterwards and the result goes to ' + path.relative(root, output) + '.' + (hold ? '\nHIGH RISK: needs a person because ' + hold + '.' : ''), Boolean(hold));
    if (!ok) return { approved: false, message: 'Minimizing was not approved. Nothing ran. Do not ask again this turn.' };
  }

  const entry = { absolute, content: original, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs };
  installExitHandler();
  LIVE.set(root, entry);
  await mkdir(path.dirname(journalPath(root)), { recursive: true });
  await writeFile(path.join(path.dirname(journalPath(root)), '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
  await writeFile(journalPath(root), JSON.stringify({ version: 1, pid: process.pid, relative, content: original.toString('base64'), mtime: info.mtimeMs, atime: info.atimeMs }), { mode: 0o600 });

  let runs = 0;
  let stopped = '';
  const cache = new Map();
  const execute = async (content) => {
    await writeFile(absolute, content);
    runs += 1;
    const result = await runWorkspaceCommand(root, argv[0], argv.slice(1), {
      approval: options.approval, autoApprove: true, ruleAllowed: Boolean(options.ruleAllowed), env: options.env || process.env,
      signal: options.signal, sandbox: options.sandbox, persistOutputLogs: false, timeoutToBackground: false, timeoutSeconds
    });
    if (!result || result.approved === false) stopped = stopped || 'denied';
    else if (result.cancelled) stopped = stopped || 'cancelled';
    return result || {};
  };
  try {
    const baseline = await execute(original);
    if (stopped) return { ok: false, message: stopped === 'denied' ? 'The command was denied. Nothing was minimized.' : 'Cancelled before the first run finished.' };
    const baseOutput = String(baseline.stderr || '') + '\n' + String(baseline.stdout || '');
    if (!baseline.timedOut && baseline.exitCode === 0) return { ok: false, runs, message: 'The command passes with the original ' + relative + ', so there is no failure to keep while shrinking. Check the command and file.', output: tail(baseOutput) };
    if (pattern && !pattern.test(baseOutput)) return { ok: false, runs, message: 'The original failure does not match output_pattern, so it cannot be used to recognize the same failure. Adjust the pattern.', output: tail(baseOutput) };
    const key = pattern ? '' : keyErrorLine(baseOutput);
    const same = (result) => {
      if (Boolean(result.timedOut) !== Boolean(baseline.timedOut)) return false;
      if (!result.timedOut && result.exitCode !== baseline.exitCode) return false;
      const out = String(result.stderr || '') + '\n' + String(result.stdout || '');
      if (pattern) return pattern.test(out);
      if (key) return out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).some((line) => line.trim() && normalizeFailure(line.trim()) === key);
      return true;
    };
    const budget = () => !stopped && runs < maxRuns && !(options.signal && options.signal.aborted);
    const test = async (units) => {
      const content = units.join('');
      const hash = createHash('sha256').update(content).digest('hex');
      if (cache.has(hash)) return cache.get(hash);
      const verdict = same(await execute(content));
      cache.set(hash, verdict);
      return verdict;
    };
    let units = splitUnits(text, granularity === 'chars' ? 'chars' : 'lines');
    const passes = [];
    let found = await ddmin(units, test, budget);
    passes.push({ granularity: granularity === 'chars' ? 'chars' : 'lines', from: units.length, to: found.units.length });
    units = found.units;
    if (granularity === 'auto' && budget() && units.join('').length <= 4000) {
      const chars = Array.from(units.join(''));
      found = await ddmin(chars, test, budget);
      passes.push({ granularity: 'chars', from: chars.length, to: found.units.length });
      units = found.units;
    }
    if (options.signal && options.signal.aborted) stopped = stopped || 'cancelled';
    const minimized = units.join('');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, minimized);
    const lines = (value) => (value.match(/\n/g) || []).length + (value && !value.endsWith('\n') ? 1 : 0);
    return {
      ok: true,
      file: relative,
      output: path.relative(root, output),
      command: commandText,
      kept_failure: pattern ? 'exit ' + (baseline.timedOut ? 'timeout' : baseline.exitCode) + ' and output matching /' + pattern.source + '/' : key ? 'exit ' + (baseline.timedOut ? 'timeout' : baseline.exitCode) + ' and "' + key + '"' : 'exit ' + (baseline.timedOut ? 'timeout' : baseline.exitCode) + ' (no error line found in the output; consider output_pattern)',
      bytes: { before: original.length, after: Buffer.byteLength(minimized) },
      lines: { before: lines(text), after: lines(minimized) },
      reduction: original.length ? Math.round((1 - Buffer.byteLength(minimized) / original.length) * 1000) / 10 + '%' : '0%',
      one_minimal: found.minimal && !stopped,
      runs,
      passes,
      minimized: minimized.length > 4000 ? minimized.slice(0, 4000) + '\n… (' + (minimized.length - 4000) + ' more characters in ' + path.relative(root, output) + ')' : minimized,
      failure: tail(baseOutput),
      notes: [
        runs >= maxRuns ? 'Stopped at max_runs (' + maxRuns + '); the result is smaller but may not be minimal. Run again on ' + path.relative(root, output) + ' to continue.' : '',
        stopped === 'cancelled' ? 'Cancelled; the smallest input found so far was written.' : '',
        stopped === 'denied' ? 'A run was denied; the smallest input found so far was written.' : '',
        'The original ' + relative + ' was restored. Turn the minimized input into a regression test before fixing the bug.'
      ].filter(Boolean)
    };
  } finally {
    restoreSync(entry);
    LIVE.delete(root);
    await rm(journalPath(root), { force: true }).catch(() => {});
  }
}
