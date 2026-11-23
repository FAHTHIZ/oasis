// mutation_probe: does the test suite actually catch a bug in the code that
// just changed?
//
// A passing test run proves the tests pass, not that they test the change. An
// agent can add a feature, add a test that never reaches it, see green and
// report success. mutation_probe measures that gap with evidence:
//
//   1. It runs the check once. It must pass, or there is nothing to measure.
//   2. Counterfactual: it puts every changed source file back to its committed
//      version and runs the check again. If the check still passes, the tests
//      do not detect the change at all.
//   3. Mutants: it makes one small, plausible bug at a time on the changed
//      lines (=== to !==, < to <=, && to ||, true to false, a negated if, an
//      off-by-one constant, + to -) and runs the check after each. A mutant the
//      check still passes with "survived": a real regression there would ship.
//
// Files are restored after every run, byte for byte and with their original
// modification time, so file-state tracking and the "changed since you read it"
// guard see no change. A journal under .oasis/mutation-probe/ holds the
// originals while a mutant is on disk; if OASIS dies mid-run, the next probe
// (or `restorePendingMutations`) puts them back. Test files are never mutated.
//
// Every run goes through runWorkspaceCommand: the permission rules, risk
// analysis, the OS sandbox and cancellation apply. One approval covers the
// whole probe, because it names the command, the files and the number of runs.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isTestConfigPath, isTestPath } from './test-tamper.mjs';
import { splitSimpleCommandLine } from './tool-aliases.mjs';

export const MUTATION_PROBE_TOOL_DEFINITION = { type: 'function', function: {
  name: 'mutation_probe',
  description: 'Measure whether the tests actually catch bugs in the code you changed, not just whether they pass. Runs the check once (it must pass), then reverts your source changes to the committed version and runs it again (if it still passes, the tests do not cover the change), then plants small bugs one at a time on the changed lines (=== to !==, < to <=, && to ||, true to false, negated if, off-by-one constant) and reruns the check after each. Reports a score and every surviving mutant with file:line, so you can add the missing assertion. Files are restored after every run. Use it after tests pass on a bug fix or feature, before saying the change is tested. Test files are never mutated. While it runs, the changed files briefly hold planted bugs: do not run it while other agents edit or test the same folder (worktree agents are fine).',
  parameters: { type: 'object', properties: {
    command: { type: 'string', description: 'The check to run, as one simple command line without pipes or && (e.g. "npm test", "pytest -q tests/test_parser.py", "go test ./pkg/..."). Prefer the narrowest command that runs the relevant tests: it runs up to max_mutants + 2 times.' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments, when command is only the program name' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative source files to mutate. Default: source files with uncommitted changes (git), excluding tests.' },
    base: { type: 'string', description: 'Git revision to diff against for changed lines and the revert check (default HEAD)' },
    max_mutants: { type: 'integer', description: '1-40; default 12' },
    revert_check: { type: 'boolean', description: 'Also run the check with the changed files reverted to base (default true)' },
    timeout_seconds: { type: 'integer', description: 'Per run, 5-600; default: three times the baseline run, at least 30' }
  }, additionalProperties: false } } };

const MAX_FILE_BYTES = 512 * 1024;
const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|scala|swift|c|cc|cpp|cxx|h|hh|hpp|cs|php|dart|lua|ex|exs|sh|bash)$/i;
const HASH_COMMENT = /\.(?:py|rb|sh|bash|ex|exs)$/i;
const PYTHONIC = /\.(?:py)$/i;
const RUBYISH = /\.(?:rb)$/i;

// ---------------------------------------------------------------------------
// Mutant generation

// Character positions of a line that are code: not inside a string literal
// and not in a trailing comment. Template literals and multi-line strings are
// treated as strings only on the line where they open and close; a mutation
// that lands in one usually fails to compile, which the report marks.
export function codeMask(line, file = '') {
  const mask = new Array(line.length).fill(false);
  const hashComment = HASH_COMMENT.test(file);
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '/' && line[index + 1] === '/') break;
    if (char === '/' && line[index + 1] === '*') break;
    if (hashComment && char === '#') break;
    mask[index] = true;
  }
  return mask;
}

function allCode(mask, start, length) {
  for (let index = start; index < start + length; index += 1) if (!mask[index]) return false;
  return true;
}

// Token swaps. Each has a pattern (global), a replacement for the match and a
// label. Patterns carry their own boundaries so `===` is never read as `==`.
const SWAPS = [
  { re: /===/g, to: '!==', label: '=== to !==' },
  { re: /!==/g, to: '===', label: '!== to ===' },
  { re: /(?<![=!<>])==(?!=)/g, to: '!=', label: '== to !=' },
  { re: /!=(?!=)/g, to: '==', label: '!= to ==' },
  { re: /(?<![<=])<=(?!=)/g, to: '<', label: '<= to <' },
  { re: /(?<![>=])>=(?!=)/g, to: '>', label: '>= to >' },
  { re: /(?<=\s)<(?=\s)/g, to: '<=', label: '< to <=' },
  { re: /(?<=\s)>(?=\s)/g, to: '>=', label: '> to >=' },
  { re: /&&/g, to: '||', label: '&& to ||' },
  { re: /\|\|/g, to: '&&', label: '|| to &&' },
  { re: /(?<=\s)\+(?=\s)/g, to: '-', label: '+ to -' },
  { re: /(?<=\s)-(?=\s)/g, to: '+', label: '- to +' },
  { re: /\btrue\b/g, to: 'false', label: 'true to false' },
  { re: /\bfalse\b/g, to: 'true', label: 'false to true' }
];
const PY_SWAPS = [
  { re: /(?<=\s)and(?=\s)/g, to: 'or', label: 'and to or' },
  { re: /(?<=\s)or(?=\s)/g, to: 'and', label: 'or to and' },
  { re: /\bTrue\b/g, to: 'False', label: 'True to False' },
  { re: /\bFalse\b/g, to: 'True', label: 'False to True' },
  { re: /\bis not None\b/g, to: 'is None', label: 'is not None to is None' },
  { re: /\bis None\b/g, to: 'is not None', label: 'is None to is not None' }
];
const RUBY_SWAPS = [
  { re: /(?<=\s)and(?=\s)/g, to: 'or', label: 'and to or' },
  { re: /(?<=\s)or(?=\s)/g, to: 'and', label: 'or to and' }
];

function matchingParen(line, open) {
  let depth = 0;
  for (let index = open; index < line.length; index += 1) {
    if (line[index] === '(') depth += 1;
    else if (line[index] === ')') { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

/** Every single-point mutation of one line, in a stable order. */
export function lineMutations(line, file = '') {
  const out = [];
  if (!line.trim() || line.length > 400) return out;
  const trimmed = line.trim();
  // Imports, declarations of types and decorators rarely mean anything when mutated.
  if (/^(?:import|export\s+\*|from\s+\S+\s+import|#include|using|package|@)/.test(trimmed)) return out;
  const mask = codeMask(line, file);
  const swaps = SWAPS.concat(PYTHONIC.test(file) ? PY_SWAPS : RUBYISH.test(file) ? RUBY_SWAPS : []);
  for (const swap of swaps) {
    swap.re.lastIndex = 0;
    for (const match of line.matchAll(swap.re)) {
      if (!allCode(mask, match.index, match[0].length)) continue;
      // `=>` arrows and `->` are not comparisons; `x - 1` inside a range is still fine.
      if (swap.to === '>=' && line[match.index + 1] === '=') continue;
      out.push({ column: match.index + 1, operator: swap.label, mutated: line.slice(0, match.index) + swap.to + line.slice(match.index + match[0].length) });
    }
  }
  // Negate an if/while condition.
  const cIf = /\b(if|while)\s*\(/.exec(line);
  if (cIf && mask[cIf.index]) {
    const open = line.indexOf('(', cIf.index);
    const close = matchingParen(line, open);
    if (close > open + 1) out.push({ column: cIf.index + 1, operator: 'negated ' + cIf[1] + ' condition', mutated: line.slice(0, open + 1) + '!(' + line.slice(open + 1, close) + ')' + line.slice(close) });
  } else {
    const pyIf = /^(\s*)(if|elif|while)\s+(.+):\s*(#.*)?$/.exec(line);
    if (pyIf && (PYTHONIC.test(file) || !CODE_EXTENSIONS.test(file))) {
      out.push({ column: pyIf[1].length + 1, operator: 'negated ' + pyIf[2] + ' condition', mutated: pyIf[1] + pyIf[2] + ' not (' + pyIf[3] + '):' + (pyIf[4] ? ' ' + pyIf[4] : '') });
    }
  }
  // Off-by-one on a small integer literal that is not part of a name, a
  // version, an index into a string or a float.
  for (const match of line.matchAll(/(?<![\w.$])(\d{1,4})(?![\w.])/g)) {
    if (!allCode(mask, match.index, match[0].length)) continue;
    const value = Number(match[1]);
    out.push({ column: match.index + 1, operator: 'constant ' + value + ' to ' + (value + 1), mutated: line.slice(0, match.index) + String(value + 1) + line.slice(match.index + match[0].length) });
  }
  // Return the opposite boolean, or nothing.
  const ret = /^(\s*)return\s+(.+?);?\s*$/.exec(line);
  if (ret && mask[ret[1].length] && !/^(?:true|false|True|False|None|null|undefined)$/.test(ret[2])) {
    if (PYTHONIC.test(file)) out.push({ column: ret[1].length + 1, operator: 'return None', mutated: ret[1] + 'return None' });
    else if (/\.(?:[cm]?[jt]sx?)$/i.test(file)) out.push({ column: ret[1].length + 1, operator: 'return undefined', mutated: ret[1] + 'return undefined;' });
  }
  const seen = new Set();
  return out.filter((item) => item.mutated !== line && !seen.has(item.mutated) && seen.add(item.mutated));
}

/**
 * Picks up to `max` mutants spread over files and lines: one per line in
 * round-robin order before a second on any line, rotating operators so a long
 * diff does not spend the budget on one kind of change.
 */
export function selectMutants(candidates, max) {
  const byLine = new Map();
  for (const item of candidates) {
    const key = item.file + ':' + item.line;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(item);
  }
  const lines = [...byLine.values()];
  const picked = [];
  for (let round = 0; picked.length < max && lines.some((list) => list.length > round); round += 1) {
    lines.forEach((list, index) => {
      if (picked.length >= max || list.length <= round) return;
      // Start each line at a different operator so the budget is not all `===`.
      picked.push(list[(index + round) % list.length]);
    });
  }
  return picked;
}

// Changed line numbers (in the working copy) per file from `git diff -U0`.
export function changedLinesFromDiff(diffText) {
  const files = new Map();
  let current = null;
  for (const line of String(diffText || '').split('\n')) {
    const target = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (target) { current = target[1] === '/dev/null' ? null : target[1].trim(); if (current && !files.has(current)) files.set(current, new Set()); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let offset = 0; offset < count; offset += 1) files.get(current).add(start + offset);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Files on disk

function git(root, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

function journalPath(root) { return path.join(root, '.oasis', 'mutation-probe', 'journal.json'); }

// Files that are on disk in a mutated state right now, per workspace, for the
// synchronous exit handler.
const LIVE = new Map();
let exitHandlerInstalled = false;
function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once('exit', () => {
    for (const [root, entries] of LIVE) {
      for (const entry of entries.values()) restoreSync(entry);
      try { rmSync(journalPath(root), { force: true }); } catch { /* best effort */ }
    }
  });
}

function restoreSync(entry) {
  try {
    if (entry.content === null) rmSync(entry.absolute, { force: true });
    else writeFileSync(entry.absolute, entry.content);
    if (entry.content !== null && entry.mtimeMs) utimesSync(entry.absolute, (entry.atimeMs || entry.mtimeMs) / 1000, entry.mtimeMs / 1000);
  } catch { /* best effort */ }
}

async function writeJournal(root, entries) {
  const file = journalPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const body = [...entries.values()].map((entry) => ({ relative: entry.relative, content: entry.content === null ? null : entry.content.toString('base64'), mtime: entry.mtimeMs || null, atime: entry.atimeMs || null }));
  await writeFile(file, JSON.stringify({ version: 1, pid: process.pid, files: body }), { mode: 0o600 });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The pid of another live probe working on this workspace, else 0. */
export function activeProbe(root) {
  if (LIVE.has(path.resolve(root))) return process.pid;
  try {
    const journal = JSON.parse(readFileSync(journalPath(root), 'utf8'));
    return journal.pid !== process.pid && processAlive(journal.pid) ? journal.pid : 0;
  } catch { return 0; }
}

/** Restores files a crashed probe left mutated. Returns the restored paths. */
export async function restorePendingMutations(root) {
  const file = journalPath(root);
  if (!existsSync(file)) return [];
  let journal;
  try { journal = JSON.parse(readFileSync(file, 'utf8')); } catch { await rm(file, { force: true }); return []; }
  // A live probe (this process or another) owns its journal.
  if (LIVE.has(path.resolve(root)) || (journal.pid !== process.pid && processAlive(journal.pid))) return [];
  const restored = [];
  for (const item of Array.isArray(journal.files) ? journal.files : []) {
    const absolute = path.resolve(root, String(item.relative || ''));
    if (!absolute.startsWith(path.resolve(root) + path.sep)) continue;
    restoreSync({ absolute, content: item.content === null ? null : Buffer.from(String(item.content), 'base64'), mtimeMs: Number(item.mtime) || null, atimeMs: Number(item.atime) || null });
    restored.push(item.relative);
  }
  await rm(file, { force: true });
  return restored;
}

async function snapshot(root, relative) {
  const absolute = path.join(root, relative);
  const info = await stat(absolute);
  return { relative, absolute, content: await readFile(absolute), mtimeMs: info.mtimeMs, atimeMs: info.atimeMs };
}

// ---------------------------------------------------------------------------
// The probe

function exitCodeOf(result) {
  if (!result || typeof result !== 'object') return null;
  return Number.isInteger(result.exitCode) ? result.exitCode : null;
}

function tail(text, limit = 600) {
  const value = String(text || '').trim();
  return value.length > limit ? '…' + value.slice(-limit) : value;
}

// A mutant "killed" only by a syntax or import error says little about the
// tests; flag it so the score is not inflated by mutants that never ran.
const COMPILE_ERROR = /SyntaxError|IndentationError|TabError|ParseError|Unexpected token|expected expression|error\[E\d+\]|cannot find symbol|compilation failed|syntax error|TS\d{4}:/i;

export async function runMutationProbe(root, args = {}, options = {}) {
  root = path.resolve(root);
  const busy = activeProbe(root);
  if (busy) return { ok: false, busy: true, message: 'Another mutation probe is running in this workspace (process ' + busy + '). Wait for it to finish; two probes would see each other\'s planted bugs.' };
  const { runWorkspaceCommand, resolveWorkspacePath, sensitivePath } = options.tools || await import('./tools.mjs');
  const restoredEarlier = await restorePendingMutations(root);
  let argv = Array.isArray(args.args) && args.args.length ? [String(args.command || ''), ...args.args.map(String)] : splitSimpleCommandLine(args.command);
  if (!argv || !argv[0]) throw new Error('mutation_probe needs one simple command line without pipes, && or redirects (for example "npm test" or "pytest -q tests/test_x.py"), or command plus args.');
  const maxMutants = Math.max(1, Math.min(40, Number.parseInt(args.max_mutants, 10) || 12));
  const base = typeof args.base === 'string' && /^[\w./~^@{}-]{1,120}$/.test(args.base) && !args.base.startsWith('-') ? args.base : 'HEAD';
  const revertCheck = args.revert_check !== false;
  const isRepo = Boolean(await git(root, ['rev-parse', '--is-inside-work-tree']));

  // Which files and lines.
  let diffLines = new Map();
  if (isRepo) {
    const diff = await git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', base, '--']);
    if (diff) diffLines = changedLinesFromDiff(diff.toString('utf8'));
    // Untracked files: every line is new.
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked) for (const name of untracked.toString('utf8').split('\0').filter(Boolean)) if (!diffLines.has(name)) diffLines.set(name, null);
  }
  let files;
  if (Array.isArray(args.paths) && args.paths.length) {
    files = [];
    for (const raw of args.paths.slice(0, 40)) {
      const target = await resolveWorkspacePath(root, String(raw), { rejectSymlinks: true });
      files.push(target.relative.split(path.sep).join('/'));
    }
  } else {
    if (!isRepo) throw new Error('This workspace is not a git repository, so mutation_probe cannot tell what changed. Pass paths with the source files to mutate.');
    files = [...diffLines.keys()];
  }
  const skipped = [];
  const targets = [];
  for (const file of [...new Set(files)]) {
    const why = isTestPath(file) ? 'test file' : isTestConfigPath(file) ? 'test configuration' : !CODE_EXTENSIONS.test(file) ? 'not a source file' : sensitivePath && sensitivePath(file) ? 'protected file' : '';
    if (why) { skipped.push({ path: file, reason: why }); continue; }
    let info;
    try { info = await stat(path.join(root, file)); } catch { skipped.push({ path: file, reason: 'missing' }); continue; }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) { skipped.push({ path: file, reason: info.isFile() ? 'larger than 512 KB' : 'not a file' }); continue; }
    targets.push(file);
  }
  if (!targets.length) {
    return { ok: false, message: 'No changed source files to probe' + (skipped.length ? ' (skipped: ' + skipped.map((item) => item.path + ' — ' + item.reason).join('; ') + ')' : '') + '. Pass paths with the source files the tests should cover.', skipped, ...(restoredEarlier.length ? { restored_from_earlier_crash: restoredEarlier } : {}) };
  }

  // Candidate mutants on changed lines.
  const candidates = [];
  const originals = new Map();
  for (const file of targets) {
    const snap = await snapshot(root, file);
    if (snap.content.includes(0)) { skipped.push({ path: file, reason: 'binary' }); continue; }
    originals.set(file, snap);
    const text = snap.content.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(eol);
    const changed = diffLines.get(file);
    const wanted = changed instanceof Set && changed.size ? changed : null;
    lines.forEach((line, index) => {
      if (wanted && !wanted.has(index + 1)) return;
      for (const mutation of lineMutations(line, file)) candidates.push({ file, line: index + 1, original: line, eol, ...mutation });
    });
  }
  const mutants = selectMutants(candidates, maxMutants);

  // Files that existed at base, for the counterfactual run.
  const revertable = [];
  if (revertCheck && isRepo) {
    for (const file of originals.keys()) {
      const content = await git(root, ['show', base + ':' + file]);
      if (content !== null) revertable.push({ file, content });
    }
  }
  const plannedRuns = 1 + (revertable.length ? 1 : 0) + mutants.length;
  if (!mutants.length && !revertable.length) {
    return { ok: false, message: 'Found nothing to mutate on the changed lines of ' + targets.join(', ') + ' (no comparisons, conditions, booleans, arithmetic or constants). The probe needs logic to test.', skipped };
  }

  // One approval for the whole probe.
  const commandText = argv.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
  // Under a prompt-injection hold a person must say yes, even in auto modes;
  // that yes covers the runs below, since it named the command and the count.
  const hold = options.injectionHold || '';
  if (hold || (!options.autoApprove && !options.ruleAllowed)) {
    const ok = options.approval && await options.approval('Run a mutation probe?\n  ' + commandText + '\nruns up to ' + plannedRuns + ' times while ' + [...originals.keys()].join(', ') + ' are changed one small bug at a time' + (revertable.length ? ' (and once with your changes reverted to ' + base + ')' : '') + '. Every file is restored after each run.' + (hold ? '\nHIGH RISK: needs a person because ' + hold + '.' : ''), Boolean(hold));
    if (!ok) return { approved: false, message: 'The mutation probe was not approved. No file was changed and nothing ran. Do not ask again this turn.' };
  }
  const runOptions = { approval: options.approval, autoApprove: true, ruleAllowed: Boolean(options.ruleAllowed), env: options.env || process.env, signal: options.signal, sandbox: options.sandbox, persistOutputLogs: false, condenseOutput: false, timeoutToBackground: false };
  const run = async (timeoutSeconds) => {
    const started = Date.now();
    const result = await runWorkspaceCommand(root, argv[0], argv.slice(1), { ...runOptions, timeoutSeconds });
    return { result, ms: Date.now() - started };
  };

  // 1. Baseline.
  const baseline = await run(Math.max(5, Math.min(600, Number.parseInt(args.timeout_seconds, 10) || 600)));
  if (baseline.result && baseline.result.approved === false) return { approved: false, message: baseline.result.message || 'The check was not approved.' };
  const baselineCode = exitCodeOf(baseline.result);
  if (baselineCode !== 0) {
    return { ok: false, baseline: { exitCode: baselineCode, timedOut: Boolean(baseline.result && baseline.result.timedOut), output: tail((baseline.result && (baseline.result.stderr || baseline.result.stdout)) || '') }, message: 'The check does not pass as the code stands, so there is nothing to measure. Make it pass first, then run mutation_probe again.' };
  }
  const perRun = Math.max(5, Math.min(600, Number.parseInt(args.timeout_seconds, 10) || Math.max(30, Math.ceil(baseline.ms * 3 / 1000))));

  const live = new Map();
  if (LIVE.has(root)) return { ok: false, busy: true, message: 'Another mutation probe started in this workspace meanwhile. Wait for it to finish.' };
  LIVE.set(root, live);
  installExitHandler();
  const putBack = async () => {
    for (const entry of live.values()) {
      if (entry.content === null) await rm(entry.absolute, { force: true });
      else { await writeFile(entry.absolute, entry.content); await utimes(entry.absolute, entry.atimeMs / 1000, entry.mtimeMs / 1000); }
    }
    live.clear();
    await rm(journalPath(root), { force: true });
  };
  const apply = async (changes) => {
    for (const change of changes) live.set(change.file, originals.get(change.file));
    await writeJournal(root, live);
    for (const change of changes) await writeFile(path.join(root, change.file), change.content);
  };
  const verdictOf = (outcome) => {
    const code = exitCodeOf(outcome.result);
    const output = String((outcome.result && ((outcome.result.stderr || '') + '\n' + (outcome.result.stdout || ''))) || '');
    if (outcome.result && outcome.result.cancelled) return { status: 'cancelled' };
    if (outcome.result && outcome.result.timedOut) return { status: 'killed', by: 'timeout' };
    if (code === 0) return { status: 'survived' };
    return { status: 'killed', by: COMPILE_ERROR.test(output) ? 'compile_error' : 'test_failure', exitCode: code, output: tail(output, 300) };
  };

  let counterfactual = null;
  const results = [];
  let cancelled = false;
  try {
    // 2. Counterfactual: the change reverted.
    if (revertable.length) {
      await apply(revertable.map((item) => ({ file: item.file, content: item.content })));
      const outcome = await run(perRun);
      await putBack();
      const verdict = verdictOf(outcome);
      if (verdict.status === 'cancelled') cancelled = true;
      counterfactual = {
        files: revertable.map((item) => item.file), base,
        tests_fail_without_change: verdict.status === 'killed',
        ...(verdict.by ? { failed_by: verdict.by } : {}),
        verdict: verdict.status === 'killed'
          ? (verdict.by === 'compile_error' ? 'The check fails without your change, but only because the old code no longer builds against the rest; that is weak evidence the tests cover the behaviour.' : 'Good: the check fails when your change is reverted, so the tests detect it.')
          : verdict.status === 'survived' ? 'The check still passes with your change reverted: the tests do not cover what you changed. Add a test that fails on the old code.' : 'Cancelled.'
      };
    }
    // 3. Mutants.
    for (const mutant of mutants) {
      if (cancelled || (options.signal && options.signal.aborted)) { cancelled = true; break; }
      const original = originals.get(mutant.file).content.toString('utf8');
      const lines = original.split(mutant.eol);
      lines[mutant.line - 1] = mutant.mutated;
      await apply([{ file: mutant.file, content: lines.join(mutant.eol) }]);
      const outcome = await run(perRun);
      await putBack();
      const verdict = verdictOf(outcome);
      if (verdict.status === 'cancelled') { cancelled = true; break; }
      results.push({ file: mutant.file, line: mutant.line, column: mutant.column, operator: mutant.operator, original: mutant.original.trim().slice(0, 200), mutated: mutant.mutated.trim().slice(0, 200), status: verdict.status, ...(verdict.by ? { killed_by: verdict.by } : {}) });
    }
  } finally {
    await putBack().catch(() => { for (const entry of live.values()) restoreSync(entry); live.clear(); });
    LIVE.delete(root);
  }

  // Byte-for-byte check that every file is back.
  const notRestored = [];
  for (const [file, snap] of originals) {
    try { if (!(await readFile(path.join(root, file))).equals(snap.content)) { restoreSync(snap); notRestored.push(file); } } catch { restoreSync(snap); notRestored.push(file); }
  }

  const survived = results.filter((item) => item.status === 'survived');
  const killed = results.filter((item) => item.status === 'killed');
  const compileOnly = killed.filter((item) => item.killed_by === 'compile_error').length;
  const meaningful = results.length - compileOnly;
  const score = meaningful > 0 ? Math.round(((killed.length - compileOnly) / meaningful) * 100) : null;
  const advice = [];
  if (counterfactual && !counterfactual.tests_fail_without_change) advice.push('Your tests pass on the old code: write a test that reproduces what you fixed or added, see it fail on the old code, then pass.');
  if (survived.length) advice.push('Each surviving mutant is a bug the tests would let through. Add an assertion that fails on the mutated line (boundary values for < / <=, both branches of a condition, the exact return value), then rerun mutation_probe.');
  if (!survived.length && results.length && (!counterfactual || counterfactual.tests_fail_without_change)) advice.push('Every mutant was caught: the tests exercise the changed lines.');
  if (compileOnly) advice.push(compileOnly + ' mutant(s) only broke the build; they are left out of the score.');

  return {
    ok: true,
    command: commandText,
    baseline: { exitCode: 0, seconds: Math.round(baseline.ms / 100) / 10 },
    ...(counterfactual ? { counterfactual } : {}),
    mutants: { tested: results.length, killed: killed.length, survived: survived.length, compile_errors: compileOnly, score_percent: score, planned: mutants.length, candidates: candidates.length },
    survivors: survived.slice(0, 40),
    killed: killed.slice(0, 40).map((item) => ({ file: item.file, line: item.line, operator: item.operator, killed_by: item.killed_by })),
    files: [...originals.keys()],
    ...(skipped.length ? { skipped } : {}),
    ...(cancelled ? { cancelled: true } : {}),
    ...(notRestored.length ? { restored_after_check: notRestored } : {}),
    ...(restoredEarlier.length ? { restored_from_earlier_crash: restoredEarlier } : {}),
    advice: advice.join(' ')
  };
}
