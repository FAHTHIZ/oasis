// localize_fault: which lines does the failure live on?
//
// Spectrum-based fault localization. Each test runs on its own with line
// coverage; a line that every failing test executes and few passing tests do
// is suspicious. The Ochiai score
//
//   suspiciousness(line) = failed(line) / sqrt(total_failed * (failed(line) + passed(line)))
//
// ranks lines, and in published comparisons (Abreu et al. 2006; Pearson et
// al. 2017, Defects4J) it puts the faulty statement near the top more often
// than reading stack traces alone, especially for wrong-result bugs where
// nothing throws at the faulty line. The agent gets a short ranked list of
// file:line with the source text, instead of reading the whole module.
//
// Coverage needs no project setup:
//   JavaScript/TypeScript on Node: NODE_V8_COVERAGE, which every Node process
//     (and child process) honours; block coverage is mapped to lines. Code
//     loaded through a transpiler without source maps maps to the generated
//     code, which the report flags.
//   Python: coverage.py (`python -m coverage`), when installed.
//
// Test files, node_modules, virtualenvs and files outside the workspace are
// left out of the ranking. Every run goes through runWorkspaceCommand
// (permission rules, risk analysis, the OS sandbox, cancellation). One
// approval covers all runs.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestPath } from './test-tamper.mjs';
import { splitSimpleCommandLine } from './tool-aliases.mjs';

export const FAULT_LOCALIZE_TOOL_DEFINITION = { type: 'function', function: {
  name: 'localize_fault',
  description: 'Rank the source lines most likely to contain a bug, from which lines failing and passing tests execute (spectrum-based fault localization, Ochiai). Runs each test on its own with line coverage (Node: built-in V8 coverage, no setup; Python: coverage.py if installed) and returns the top suspicious file:line ranges with their source text. Use it when some tests fail and others pass and the failure gives no clear location (a wrong result, not a crash with a stack trace), before reading whole modules. Needs at least one failing and one passing test; more tests sharpen the ranking.',
  parameters: { type: 'object', properties: {
    command: { type: 'string', description: 'The test runner, as one simple command line; each test is appended to it (e.g. "node --test", "npx vitest run", "pytest -q")' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments, when command is only the program name' },
    tests: { type: 'array', items: { type: 'string' }, description: 'The tests to run one at a time: test files or ids (e.g. ["test/a.test.mjs", "test/b.test.mjs"] or ["tests/test_x.py::test_one"]), 2-60' },
    top: { type: 'integer', description: 'How many ranked locations to return, 1-50; default 15' },
    timeout_seconds: { type: 'integer', description: 'Per test, 5-600; default 120' }
  }, required: ['command', 'tests'], additionalProperties: false } } };

const SKIP_DIR = /(^|\/)(node_modules|\.venv|venv|site-packages|dist-packages|\.oasis|\.git|coverage|__pycache__)(\/|$)/;

/** Ochiai suspiciousness. */
export function ochiai(failedHere, passedHere, totalFailed) {
  if (!failedHere || !totalFailed) return 0;
  return failedHere / Math.sqrt(totalFailed * (failedHere + passedHere));
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

/**
 * Turns V8 block coverage for one script into the set of executed lines
 * (1-based). Ranges nest: a larger range's count is overridden by the
 * smaller ranges inside it, so they are applied largest first. A line counts
 * as executed when any non-blank character on it ran.
 */
export function v8LinesExecuted(source, functions) {
  const counts = new Int32Array(source.length).fill(-1);
  const ranges = [];
  for (const fn of functions || []) for (const range of fn.ranges || []) ranges.push(range);
  ranges.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
  for (const range of ranges) {
    const start = Math.max(0, range.startOffset);
    const end = Math.min(source.length, range.endOffset);
    counts.fill(range.count > 0 ? 1 : 0, start, end);
  }
  const executed = new Set();
  const starts = lineStarts(source);
  for (let line = 0; line < starts.length; line += 1) {
    const end = line + 1 < starts.length ? starts[line + 1] : source.length;
    for (let index = starts[line]; index < end; index += 1) {
      const code = source.charCodeAt(index);
      if (code === 32 || code === 9 || code === 10 || code === 13) continue;
      if (counts[index] === 1) { executed.add(line + 1); break; }
    }
  }
  return executed;
}

function relativeSource(root, file) {
  const relative = path.relative(root, file).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  if (SKIP_DIR.test(relative) || isTestPath(relative)) return '';
  return relative;
}

async function readV8Coverage(root, dir) {
  const lines = new Map();
  let names = [];
  try { names = (await readdir(dir)).filter((name) => name.endsWith('.json')); } catch { return lines; }
  const sources = new Map();
  for (const name of names) {
    let data;
    try { data = JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch { continue; }
    for (const script of data.result || []) {
      if (!String(script.url || '').startsWith('file:')) continue;
      let file;
      try { file = fileURLToPath(script.url); } catch { continue; }
      const relative = relativeSource(root, file);
      if (!relative) continue;
      if (!sources.has(file)) { try { sources.set(file, readFileSync(file, 'utf8')); } catch { sources.set(file, null); } }
      const source = sources.get(file);
      if (source == null) continue;
      const executed = v8LinesExecuted(source, script.functions);
      const seen = lines.get(relative) || new Set();
      for (const line of executed) seen.add(line);
      lines.set(relative, seen);
    }
  }
  return lines;
}

async function readPythonCoverage(root, file) {
  const lines = new Map();
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch { return lines; }
  for (const [name, info] of Object.entries(data.files || {})) {
    const relative = relativeSource(root, path.resolve(root, name));
    if (!relative) continue;
    lines.set(relative, new Set(info.executed_lines || []));
  }
  return lines;
}

function isPython(argv) {
  const program = path.basename(argv[0]).toLowerCase();
  return /^python(?:\d(?:\.\d+)?)?(?:\.exe)?$/.test(program) || /^(?:pytest|py\.test)(?:\.exe)?$/.test(program);
}

/** Ranks lines from per-test coverage. Exported for tests. */
export function rankLines(results, { top = 15 } = {}) {
  const failedTests = results.filter((run) => !run.passed);
  const totalFailed = failedTests.length;
  const tally = new Map();
  for (const run of results) {
    for (const [file, lines] of run.coverage) {
      for (const line of lines) {
        const key = file + ':' + line;
        const entry = tally.get(key) || { file, line, failed: 0, passed: 0 };
        if (run.passed) entry.passed += 1; else entry.failed += 1;
        tally.set(key, entry);
      }
    }
  }
  const scored = [...tally.values()].map((entry) => ({ ...entry, score: ochiai(entry.failed, entry.passed, totalFailed) })).filter((entry) => entry.score > 0);
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  // Merge neighbouring lines with the same score and counts into one range.
  const ranges = [];
  const byFile = new Map();
  for (const entry of scored) {
    const list = byFile.get(entry.file) || [];
    list.push(entry);
    byFile.set(entry.file, list);
  }
  for (const list of byFile.values()) {
    list.sort((a, b) => a.line - b.line);
    for (const entry of list) {
      const last = ranges.length ? ranges[ranges.length - 1] : null;
      if (last && last.file === entry.file && last.end === entry.line - 1 && last.score === entry.score && last.failed === entry.failed && last.passed === entry.passed) last.end = entry.line;
      else ranges.push({ file: entry.file, start: entry.line, end: entry.line, score: entry.score, failed: entry.failed, passed: entry.passed });
    }
  }
  ranges.sort((a, b) => b.score - a.score || (a.end - a.start) - (b.end - b.start) || a.file.localeCompare(b.file) || a.start - b.start);
  // Dense rank: locations with the same score share a rank, which says how
  // many lines the agent may have to read before reaching the fault.
  let rank = 0;
  let previous = null;
  for (const range of ranges) {
    if (range.score !== previous) { rank += 1; previous = range.score; }
    range.rank = rank;
  }
  return { ranges: ranges.slice(0, top), total: ranges.length, totalFailed, totalPassed: results.length - totalFailed };
}

function tail(text, limit = 300) {
  const value = String(text || '').trim();
  return value.length > limit ? '…' + value.slice(-limit) : value;
}

export async function runLocalizeFault(root, args = {}, options = {}) {
  root = path.resolve(root);
  const { runWorkspaceCommand } = options.tools || await import('./tools.mjs');
  const argv = Array.isArray(args.args) && args.args.length ? [String(args.command || ''), ...args.args.map(String)] : splitSimpleCommandLine(args.command);
  if (!argv || !argv[0]) throw new Error('localize_fault needs one simple command line for the test runner (for example "node --test" or "pytest -q"), or command plus args.');
  const tests = [...new Set((Array.isArray(args.tests) ? args.tests : []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (tests.length < 2) throw new Error('localize_fault needs at least two tests (one failing, one passing) in tests.');
  if (tests.length > 60) throw new Error('localize_fault runs at most 60 tests; pass the failing tests and the passing tests closest to them.');
  for (const item of tests) if (item.startsWith('-') || /[|&;<>`$]/.test(item)) throw new Error('Each test must be a test file or id, not an option or shell syntax: ' + item);
  const top = Math.max(1, Math.min(50, Number.parseInt(args.top, 10) || 15));
  const timeoutSeconds = Math.max(5, Math.min(600, Number.parseInt(args.timeout_seconds, 10) || 120));
  const python = isPython(argv);
  const commandText = argv.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');

  const hold = options.injectionHold || '';
  if (hold || (!options.autoApprove && !options.ruleAllowed)) {
    const ok = options.approval && await options.approval('Run ' + tests.length + ' tests one at a time with line coverage to rank suspicious lines?\n  ' + commandText + ' <test>' + (python ? '\n(through python -m coverage)' : '') + (hold ? '\nHIGH RISK: needs a person because ' + hold + '.' : ''), Boolean(hold));
    if (!ok) return { approved: false, message: 'Fault localization was not approved. Nothing ran. Do not ask again this turn.' };
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'oasis-sbfl-'));
  const base = options.env || process.env;
  const run = (cwd, command, commandArgs, env, seconds = timeoutSeconds) => runWorkspaceCommand(cwd, command, commandArgs, {
    approval: options.approval, autoApprove: true, ruleAllowed: Boolean(options.ruleAllowed), env,
    signal: options.signal, sandbox: options.sandbox, persistOutputLogs: false, timeoutToBackground: false, timeoutSeconds: seconds
  });
  const results = [];
  const notes = [];
  let stopped = '';
  try {
    let pythonProgram = '';
    if (python) {
      pythonProgram = /^python/i.test(path.basename(argv[0])) ? argv[0] : 'python3';
      const probe = await run(root, pythonProgram, ['-m', 'coverage', '--version'], base, 30);
      if (!probe || probe.exitCode !== 0) return { ok: false, message: 'Python coverage is not installed here (python -m coverage failed). Install coverage (pip install coverage) or run localize_fault on JavaScript tests.' };
    }
    for (let index = 0; index < tests.length; index += 1) {
      if (options.signal && options.signal.aborted) { stopped = 'cancelled'; break; }
      const name = tests[index];
      const dir = path.join(scratch, String(index));
      let result;
      let coverage;
      if (python) {
        const data = path.join(dir, '.coverage');
        const out = path.join(dir, 'coverage.json');
        const pyArgs = /^python/i.test(path.basename(argv[0])) ? argv.slice(1) : ['-m', path.basename(argv[0]).replace(/\.exe$/i, '').replace(/^py\.test$/, 'pytest'), ...argv.slice(1)];
        // `python -m pytest -q` becomes `python -m coverage run -m pytest -q`.
        const wrapped = pyArgs[0] === '-m' ? ['-m', 'coverage', 'run', '--data-file=' + data, '-m', ...pyArgs.slice(1), name] : ['-m', 'coverage', 'run', '--data-file=' + data, ...pyArgs, name];
        await mkdir(dir, { recursive: true });
        result = await run(root, pythonProgram, wrapped, base);
        await run(root, pythonProgram, ['-m', 'coverage', 'json', '--data-file=' + data, '-o', out, '-q'], base, 60);
        coverage = await readPythonCoverage(root, out);
      } else {
        result = await run(root, argv[0], [...argv.slice(1), name], { ...base, NODE_V8_COVERAGE: dir });
        coverage = await readV8Coverage(root, dir);
      }
      if (!result || result.approved === false) { stopped = 'denied'; break; }
      if (result.cancelled) { stopped = 'cancelled'; break; }
      const passed = !result.timedOut && result.exitCode === 0;
      results.push({ test: name, passed, exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null, timedOut: Boolean(result.timedOut), coverage, output: passed ? '' : tail(String(result.stderr || '') + '\n' + String(result.stdout || '')) });
      if (!coverage.size) notes.push('No source coverage was recorded for ' + name + (python ? '.' : '; if the tests run in a browser, a separate runner process that clears NODE_V8_COVERAGE, or through a transpiler without source files on disk, coverage cannot be read.'));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  if (!results.length) return { ok: false, message: stopped === 'denied' ? 'A test run was denied. Nothing was ranked.' : 'Cancelled before any test finished.' };
  const summary = rankLines(results, { top });
  const tests_run = results.map((item) => ({ test: item.test, result: item.passed ? 'pass' : item.timedOut ? 'timeout' : 'fail', exit_code: item.exitCode, covered_files: item.coverage.size, ...(item.output ? { output: item.output } : {}) }));
  if (!summary.totalFailed) return { ok: false, tests: tests_run, message: 'Every test passed, so there is no failure to localize. Include a failing test.' };
  if (!summary.totalPassed) notes.push('No test passed, so every line the failing tests ran scores the same. Add passing tests that exercise nearby code to sharpen the ranking.');
  const sourceCache = new Map();
  const snippet = (file, start, end) => {
    if (!sourceCache.has(file)) { const absolute = path.join(root, file); sourceCache.set(file, existsSync(absolute) ? readFileSync(absolute, 'utf8').split(/\r?\n/) : []); }
    const lines = sourceCache.get(file);
    return lines.slice(start - 1, Math.min(end, start + 4)).map((text, offset) => (start + offset) + '  ' + text.slice(0, 160)).join('\n');
  };
  const locations = summary.ranges.map((range) => ({
    rank: range.rank,
    location: range.file + ':' + range.start + (range.end > range.start ? '-' + range.end : ''),
    score: Math.round(range.score * 1000) / 1000,
    failing_tests_ran_it: range.failed + '/' + summary.totalFailed,
    passing_tests_ran_it: range.passed + '/' + summary.totalPassed,
    code: snippet(range.file, range.start, range.end)
  }));
  const tied = locations.filter((item) => item.rank === 1).length;
  if (tied > 5) notes.push(tied + ' locations share the top score: the passing tests do not tell them apart. Add a passing test that runs most of that code but not the failing case.');
  if (stopped) notes.push(stopped === 'cancelled' ? 'Cancelled after ' + results.length + ' of ' + tests.length + ' tests; the ranking uses those.' : 'A run was denied after ' + results.length + ' tests; the ranking uses those.');
  return {
    ok: true,
    method: 'Ochiai spectrum-based fault localization over per-test line coverage (' + (python ? 'coverage.py' : 'V8') + ')',
    failing: summary.totalFailed,
    passing: summary.totalPassed,
    locations,
    ranked_locations: summary.total,
    tests: tests_run,
    notes,
    advice: 'Read the top-ranked locations first, with the failing test\'s expectation in mind. A high score is a lead, not proof: confirm the bug in the code before you change it.'
  };
}
