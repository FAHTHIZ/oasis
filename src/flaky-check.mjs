// flaky_check: is this failure real, or does the check fail at random?
//
// An agent that sees one red test run usually starts editing code. When the
// test is flaky, that edit "fixes" nothing, the next run is green by chance,
// and the change ships with a false explanation. This tool reruns the same
// check several times on the same files and classifies it:
//
//   passes         every run passed
//   fails          every run failed the same way (a real, reproducible failure)
//   fails-varied   every run failed, but with different errors (unstable setup,
//                  order dependence, or several bugs at once)
//   flaky          some runs passed and some failed on identical code
//
// Failures are grouped by a signature: the last meaningful lines of output
// with numbers, durations, hex ids, temp paths and timestamps masked, so "port
// 51234 in use" and "port 51877 in use" count as one cause. With concurrency
// above 1, copies of the check run at the same time in the same folder, which
// exposes tests that share files, ports or databases. The report also notes
// when failing runs were much slower than passing ones (a timeout or race)
// and names cause keywords found in the output (ports, network, time zone,
// randomness, ordering).
//
// Every run goes through runWorkspaceCommand (permission rules, risk
// analysis, the OS sandbox, cancellation). One approval covers all runs.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { splitSimpleCommandLine } from './tool-aliases.mjs';

export const FLAKY_CHECK_TOOL_DEFINITION = { type: 'function', function: {
  name: 'flaky_check',
  description: 'Rerun a failing (or suspicious) check several times on the same code and classify it: passes, fails (reproducible, same error every time), fails-varied, or flaky (passes and fails on identical code). Groups failures by error signature and points at likely causes (timing, ports, network, time zone, randomness, test order). Use it before editing code to fix a test that failed once, when a check passed after a change that should not have mattered, or before trusting a single green run of a test known to be unreliable. concurrency > 1 runs copies at the same time to expose tests that share files or ports.',
  parameters: { type: 'object', properties: {
    command: { type: 'string', description: 'The check, as one simple command line (e.g. "npm test -- test/api.test.mjs", "pytest -q tests/test_cache.py::test_expiry"). The narrowest check that shows the failure is fastest.' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments, when command is only the program name' },
    runs: { type: 'integer', description: 'How many times to run it, 2-30; default 6' },
    concurrency: { type: 'integer', description: 'Copies to run at the same time, 1-4; default 1. Above 1 exposes shared ports, files and databases.' },
    stop_when_flaky: { type: 'boolean', description: 'Stop as soon as both a pass and a failure were seen (default true). Set false to measure the failure rate.' },
    timeout_seconds: { type: 'integer', description: 'Per run, 5-900; default 180' }
  }, required: ['command'], additionalProperties: false } } };

const CAUSES = [
  ['ports', /\bEADDRINUSE\b|address already in use|port \d+ (?:is )?(?:already )?in use/i, 'a port is already taken: runs (or another process) share a fixed port; use port 0 or a per-test port'],
  ['network', /\bECONNREFUSED\b|\bECONNRESET\b|\bENOTFOUND\b|\bEAI_AGAIN\b|socket hang up|network is unreachable|connection (?:refused|reset)/i, 'a network call failed: the test depends on a server or the internet; start the service in the test or stub the call'],
  ['timing', /\btimed? ?out\b|\bETIMEDOUT\b|exceeded timeout|deadline exceeded|test timeout/i, 'something timed out: a fixed sleep or timeout is too short on a busy machine; wait for the condition instead of a duration'],
  ['files', /\bEBUSY\b|\bEEXIST\b|\bENOENT\b|\bEPERM\b|database is locked|resource busy|text file busy/i, 'a file or lock was missing or in use: tests share a path, or one deletes what another reads; give each test its own temp folder'],
  ['time', /time ?zone|\bTZ\b|daylight|\bDST\b|midnight|toLocale|Date\.now|datetime\.now|leap/i, 'the output mentions dates or time zones: the result may depend on the clock; freeze time in the test'],
  ['randomness', /\brandom\b|\bseed\b|Math\.random|uuid|shuffle/i, 'the output mentions randomness: fix the seed, or assert on properties instead of exact values'],
  ['order', /test order|run order|in a different order|beforeEach|afterEach|beforeAll|shared state|already (?:registered|defined|exists)|leak/i, 'the output suggests order or shared state: a test depends on what another left behind; reset state between tests'],
  ['memory', /out of memory|heap out of memory|\bENOMEM\b|killed|signal 9|SIGKILL/i, 'a run ran out of memory or was killed: the machine was under load']
];

/** Masks the parts of an error that differ between identical failures. */
export function normalizeFailure(text) {
  const lines = String(text || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:at |#|ℹ|\u2139|duration_ms|\d+ (?:passing|failing|pending)|Ran \d+ tests?|tests? \d+|pass \d+|fail \d+)/i.test(line));
  return lines.slice(-6).join('\n')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<time>')
    .replace(/(?:\/tmp|\/var\/folders|[A-Z]:\\Users\\[^\\\s]+\\AppData\\Local\\Temp)[^\s'"`)]*/g, '<tmp>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|µs|us|ns|m)\b/g, '<duration>')
    .replace(/\d+/g, 'N')
    .slice(0, 1200);
}

function signatureOf(run) {
  if (run.timedOut) return 'timeout';
  return createHash('sha256').update('exit ' + run.exitCode + '\n' + normalizeFailure(run.output)).digest('hex').slice(0, 12);
}

function tail(text, limit = 600) {
  const value = String(text || '').trim();
  return value.length > limit ? '…' + value.slice(-limit) : value;
}

/** Classifies a list of runs; exported for tests. */
export function classifyRuns(runs) {
  const passed = runs.filter((run) => run.passed);
  const failed = runs.filter((run) => !run.passed);
  const groups = new Map();
  for (const run of failed) {
    const key = signatureOf(run);
    const group = groups.get(key) || { signature: key, count: 0, exit_code: run.exitCode, timed_out: Boolean(run.timedOut), runs: [], example: tail(run.output) };
    group.count += 1;
    group.runs.push(run.index);
    groups.set(key, group);
  }
  const failures = [...groups.values()].sort((a, b) => b.count - a.count);
  const verdict = !failed.length ? 'passes' : !passed.length ? (failures.length > 1 ? 'fails-varied' : 'fails') : 'flaky';
  const mean = (list) => list.length ? list.reduce((sum, run) => sum + run.seconds, 0) / list.length : 0;
  const hints = [];
  if (passed.length && failed.length) {
    const slowFail = mean(failed);
    const fastPass = mean(passed);
    if (slowFail > 1.5 * fastPass && slowFail - fastPass > 0.5) hints.push('failing runs took ' + slowFail.toFixed(1) + 's on average against ' + fastPass.toFixed(1) + 's for passing ones: likely a timeout or race under load');
  }
  const text = failed.map((run) => run.output).join('\n');
  const causes = CAUSES.filter(([, pattern]) => pattern.test(text)).map(([name, , hint]) => ({ cause: name, hint }));
  return { verdict, passed: passed.length, failed: failed.length, failures, causes, hints };
}

function adviceFor(result, concurrency) {
  if (result.verdict === 'passes') return concurrency > 1
    ? 'Every run passed, including copies run at the same time. A failure seen earlier was not reproduced here; it may depend on the machine, the environment or on other changes since.'
    : 'Every run passed. A failure seen earlier was not reproduced; try concurrency 2-4 to load the machine, or check whether the environment differed.';
  if (result.verdict === 'fails') return 'Reproducible: every run failed with the same error. This is a real failure; fix the cause before rerunning.';
  if (result.verdict === 'fails-varied') return 'Every run failed, but with ' + result.failures.length + ' different errors. Fix the most common one first; the others may be knock-on effects, order dependence or an unstable setup.';
  return 'Flaky: the same code passed ' + result.passed + ' and failed ' + result.failed + ' time(s). Do not treat one pass as proof of a fix, and do not change product code to make it green. Find the nondeterminism (see causes) and fix the test or its setup.';
}

export async function runFlakyCheck(root, args = {}, options = {}) {
  root = path.resolve(root);
  const { runWorkspaceCommand } = options.tools || await import('./tools.mjs');
  const argv = Array.isArray(args.args) && args.args.length ? [String(args.command || ''), ...args.args.map(String)] : splitSimpleCommandLine(args.command);
  if (!argv || !argv[0]) throw new Error('flaky_check needs one simple command line without pipes, && or redirects (for example "npm test"), or command plus args.');
  const total = Math.max(2, Math.min(30, Number.parseInt(args.runs, 10) || 6));
  const concurrency = Math.max(1, Math.min(4, Number.parseInt(args.concurrency, 10) || 1));
  const stopWhenFlaky = args.stop_when_flaky !== false;
  const timeoutSeconds = Math.max(5, Math.min(900, Number.parseInt(args.timeout_seconds, 10) || 180));
  const commandText = argv.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');

  const hold = options.injectionHold || '';
  if (hold || (!options.autoApprove && !options.ruleAllowed)) {
    const ok = options.approval && await options.approval('Run this check up to ' + total + ' times' + (concurrency > 1 ? ' (' + concurrency + ' at a time)' : '') + ' to see whether it is flaky?\n  ' + commandText + (hold ? '\nHIGH RISK: needs a person because ' + hold + '.' : ''), Boolean(hold));
    if (!ok) return { approved: false, message: 'The flaky check was not approved. Nothing ran. Do not ask again this turn.' };
  }

  const runs = [];
  let next = 0;
  let stopped = '';
  const runOne = async (index) => {
    const started = Date.now();
    const result = await runWorkspaceCommand(root, argv[0], argv.slice(1), {
      approval: options.approval, autoApprove: true, ruleAllowed: Boolean(options.ruleAllowed), env: options.env || process.env,
      signal: options.signal, sandbox: options.sandbox, persistOutputLogs: false, timeoutToBackground: false, timeoutSeconds
    });
    if (!result || result.approved === false) { stopped = stopped || 'denied'; return; }
    if (result.cancelled) { stopped = stopped || 'cancelled'; return; }
    runs.push({
      index, passed: !result.timedOut && result.exitCode === 0, exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
      timedOut: Boolean(result.timedOut), seconds: Math.round((Date.now() - started) / 100) / 10,
      output: String(result.stderr || '') + '\n' + String(result.stdout || '')
    });
  };
  const worker = async () => {
    while (!stopped && next < total) {
      if (options.signal && options.signal.aborted) { stopped = 'cancelled'; return; }
      const index = ++next;
      await runOne(index);
      if (stopWhenFlaky && runs.some((run) => run.passed) && runs.some((run) => !run.passed)) stopped = stopped || 'flaky';
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  runs.sort((a, b) => a.index - b.index);

  if (!runs.length) return { ok: false, approved: stopped !== 'denied', message: stopped === 'denied' ? 'The run was denied. Nothing ran.' : 'Cancelled before any run finished.' };
  const summary = classifyRuns(runs);
  const result = {
    ok: true,
    command: commandText,
    verdict: summary.verdict,
    runs: runs.length,
    passed: summary.passed,
    failed: summary.failed,
    failure_rate: Math.round((summary.failed / runs.length) * 100) / 100,
    concurrency,
    failures: summary.failures,
    causes: summary.causes,
    timeline: runs.map((run) => ({ run: run.index, result: run.passed ? 'pass' : run.timedOut ? 'timeout' : 'fail', exit_code: run.exitCode, seconds: run.seconds, signature: run.passed ? undefined : signatureOf(run) })),
    notes: [...summary.hints, stopped === 'flaky' && runs.length < total ? 'Stopped after ' + runs.length + ' of ' + total + ' runs: both outcomes were seen. Pass stop_when_flaky:false to measure the rate.' : '', stopped === 'cancelled' ? 'Cancelled after ' + runs.length + ' run(s).' : ''].filter(Boolean)
  };
  result.advice = adviceFor(result, concurrency);
  if (summary.verdict === 'passes' || summary.verdict === 'fails') result.confidence = runs.length >= 5 ? 'Consistent over ' + runs.length + ' runs.' : 'Only ' + runs.length + ' runs; a rare flake can hide in that few.';
  return result;
}
