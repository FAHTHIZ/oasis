// Best-of-N attempts: run one task several times in parallel, each attempt in
// its own Git worktree, then let the project's own check decide which result
// to keep.
//
// Codex (`codex cloud exec --attempts`) and Cursor (`/best-of-n`) both run
// parallel attempts but leave the choice to the user. OASIS runs the user's
// verify command in every attempt's worktree, rejects attempts that weaken
// tests (test-tamper analysis on the attempt's own diff), and ranks the rest
// by evidence: verified first, then smaller diffs, then speed. Each attempt's
// patch is saved under .oasis/attempts/<run>/ so nothing is lost when the
// worktrees are removed, and --apply brings only a verified winner back into
// the main checkout.
import { spawn } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorktree, removeWorktree, runWorktreeCommand } from './worktrees.mjs';
import { runAutoTest } from './auto-test.mjs';
import { analyzeTestDiff } from './test-tamper.mjs';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';

export const MAX_ATTEMPTS = 8;
export const ATTEMPTS_DIR = path.join('.oasis', 'attempts');
const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const OUTPUT_LIMIT = 400000;

const USAGE = 'Usage: oasis attempts [N] [--models a,b] [--verify "CMD"] [--apply] [--keep] [--concurrency N] [--max-turns N] [--timeout-seconds S] [--permission-mode MODE] [--json] TASK';

export function parseAttemptsArgs(args) {
  const options = { count: null, models: [], verify: null, apply: false, keep: false, concurrency: null, maxTurns: null, timeoutSeconds: 1800, permissionMode: 'acceptEdits', json: false, prompt: '' };
  const words = [];
  const value = (i, flag) => {
    const next = args[i + 1];
    if (next === undefined || (next.startsWith('-') && next !== '-')) throw new Error(flag + ' needs a value. ' + USAGE);
    return next;
  };
  const integer = (raw, flag, min, max) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(flag + ' must be a whole number from ' + min + ' to ' + max + '.');
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    // A leading whole number is the attempt count: oasis attempts 3 "fix the bug".
    if (!words.length && options.count === null && /^\d+$/.test(arg) && i < args.length - 1) { options.count = integer(arg, 'The attempt count', 1, MAX_ATTEMPTS); }
    else if (arg === '--attempts' || arg === '--count') { options.count = integer(value(i, arg), arg, 1, MAX_ATTEMPTS); i++; }
    else if (arg === '--models') {
      options.models = value(i, arg).split(',').map((m) => m.trim()).filter(Boolean); i++;
      if (!options.models.length) throw new Error(arg + ' needs at least one model name.');
    }
    else if (arg === '--verify') { options.verify = value(i, arg).trim() || null; i++; }
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--concurrency') { options.concurrency = integer(value(i, arg), arg, 1, MAX_ATTEMPTS); i++; }
    else if (arg === '--max-turns') { options.maxTurns = integer(value(i, arg), arg, 1, 1000); i++; }
    else if (arg === '--timeout-seconds') { options.timeoutSeconds = integer(value(i, arg), arg, 10, 86400); i++; }
    else if (arg === '--permission-mode') { options.permissionMode = value(i, arg); i++; }
    else if (arg === '--help' || arg === '-h') { options.help = true; }
    else if (arg.startsWith('-') && arg !== '-') throw new Error('Unknown option ' + arg + '. ' + USAGE);
    else words.push(arg);
  }
  options.prompt = words.join(' ').trim();
  if (options.help) return options;
  if (!options.prompt) throw new Error('Give the task to attempt. ' + USAGE);
  if (options.count === null) options.count = options.models.length > 1 ? Math.min(options.models.length, MAX_ATTEMPTS) : 2;
  return options;
}

export function attemptsUsage() { return USAGE; }

/** One entry per attempt; models rotate when there are fewer models than attempts. */
export function planAttempts({ count, models = [] }) {
  return Array.from({ length: count }, (_, index) => ({ index: index + 1, model: models.length ? models[index % models.length] : null }));
}

function lineCount(numstat) {
  let added = 0; let removed = 0; let files = 0;
  for (const line of String(numstat || '').split('\n')) {
    const [a, r] = line.split('\t');
    if (a === undefined || r === undefined) continue;
    files++;
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { files, added, removed, changed: added + removed };
}

/**
 * Order attempts by evidence. A lower key wins:
 *   produced changes > verify command passed (or no command) > no weakened tests >
 *   agent run succeeded > agent's own verification complete > fewer changed lines > faster.
 * Attempts whose verify command failed or that weakened tests are never "verified".
 */
export function rankAttempts(results) {
  const key = (r) => [
    r.diff && r.diff.changed > 0 ? 0 : 1,
    r.verify ? (r.verify.passed ? 0 : 2) : 1,
    r.tamper && r.tamper.length ? 1 : 0,
    r.agent && !r.agent.isError ? 0 : 1,
    r.agent && r.agent.verificationIncomplete ? 1 : 0,
    r.diff ? r.diff.changed : Number.MAX_SAFE_INTEGER,
    r.durationMs || 0
  ];
  const ranked = [...results].sort((a, b) => {
    const ka = key(a); const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.index - b.index;
  });
  return ranked.map((r, i) => ({ ...r, rank: i + 1, verified: Boolean(r.verify && r.verify.passed && !(r.tamper && r.tamper.length) && r.diff && r.diff.changed > 0) }));
}

/** The winner is the top-ranked verified attempt; with no verify command nothing is "verified". */
export function pickWinner(ranked) {
  return ranked.find((r) => r.verified) || null;
}

async function git(cwd, args, env, timeout = 60000) {
  const result = await runWorktreeCommand('git', args, { cwd, timeout, env: { PATH: env.PATH || process.env.PATH, HOME: env.HOME || process.env.HOME, GIT_TERMINAL_PROMPT: '0', LANG: 'C' } });
  if (result.exitCode !== 0) throw new Error(result.stderr || ('git ' + args[0] + ' exited with code ' + result.exitCode));
  return result.stdout;
}

function rawGit(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { PATH: env.PATH || process.env.PATH, HOME: env.HOME || process.env.HOME, GIT_TERMINAL_PROMPT: '0', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = []; let err = '';
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim() || 'git ' + args[0] + ' exited with code ' + code)));
  });
}

/**
 * Binary patch of everything the attempt changed relative to its base,
 * including new files. Shared-directory symlinks (node_modules) are excluded.
 */
export async function captureAttemptPatch(worktree, env = process.env) {
  const listed = await git(worktree.path, ['ls-files', '--others', '--exclude-standard', '-z'], env).catch(() => '');
  const skip = new Set((worktree.symlinks || []).map((s) => s.split(path.sep).join('/')));
  const untracked = [];
  for (const file of listed.split('\0').filter(Boolean)) {
    if (skip.has(file) || [...skip].some((s) => file.startsWith(s + '/'))) continue;
    const info = await lstat(path.join(worktree.path, file)).catch(() => null);
    if (info && (info.isFile() || info.isSymbolicLink())) untracked.push(file);
  }
  for (let i = 0; i < untracked.length; i += 200) await git(worktree.path, ['add', '-N', '--', ...untracked.slice(i, i + 200)], env);
  // runWorktreeCommand trims output, which corrupts a patch's final hunk.
  const patch = await rawGit(worktree.path, ['diff', '--binary', '--no-ext-diff', '--no-textconv', worktree.base, '--'], env);
  const numstat = await git(worktree.path, ['diff', '--numstat', '--no-ext-diff', worktree.base, '--'], env);
  return { patch, stats: lineCount(numstat) };
}

function parseAgentJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const event = JSON.parse(text);
      if (event && event.type === 'result') return event;
    } catch {}
  }
  return null;
}

/** Default runner: a fresh `oasis -p` process rooted in the attempt's worktree. */
export function spawnOasisAttempt({ worktree, prompt, model, options, env, signal }) {
  const args = [CLI_PATH, '-C', worktree.path, '-p', prompt, '--output-format', 'json', '--no-session-persistence', '--permission-mode', options.permissionMode || 'acceptEdits'];
  if (model) args.push('--model', model);
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
  const timeoutMs = (options.timeoutSeconds || 1800) * 1000;
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
    const child = spawn(process.execPath, args, { cwd: worktree.path, env: { ...env, OASIS_PROGRESS: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...processTreeSpawnOptions() });
    const stop = () => { signalProcessTree(child, 'SIGTERM'); setTimeout(() => signalProcessTree(child, 'SIGKILL'), 2000).unref?.(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => stop();
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout.on('data', (c) => { stdout = (stdout + c).slice(-OUTPUT_LIMIT); });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-OUTPUT_LIMIT); });
    const finish = (exitCode, error) => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const summary = parseAgentJson(stdout);
      resolve({
        exitCode, timedOut,
        isError: timedOut || exitCode !== 0 || !summary || summary.is_error === true,
        subtype: summary ? summary.subtype : (timedOut ? 'error_timeout' : 'error_no_result'),
        result: summary ? String(summary.result || '') : String(error || stderr || '').slice(-2000),
        usage: summary && summary.usage || null,
        costUsd: summary && Number.isFinite(summary.total_cost_usd) ? summary.total_cost_usd : null,
        toolCalls: summary ? summary.tool_calls : null,
        verificationIncomplete: Boolean(summary && summary.verification_issues),
        log: stderr.slice(-20000)
      });
    };
    child.on('error', (error) => finish(127, error.message));
    child.on('close', (code, sig) => finish(typeof code === 'number' ? code : (sig ? 128 : 1)));
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function excludeAttemptsDir(root, env) {
  const common = path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'], env)).trim());
  const file = path.join(common, 'info', 'exclude');
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).includes('/.oasis/attempts/')) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, (current && !current.endsWith('\n') ? '\n' : '') + '/.oasis/attempts/\n');
}

/**
 * Run the attempts. `runAttempt` defaults to spawning `oasis -p`; tests inject
 * a scripted runner. Returns { runId, dir, ranked, winner, applied }.
 */
export async function runBestOfN(root, options, { env = process.env, runAttempt = spawnOasisAttempt, signal = null, onProgress = () => {} } = {}) {
  const top = (await git(root, ['rev-parse', '--show-toplevel'], env).catch(() => { throw new Error('oasis attempts needs a Git repository (each attempt runs in its own worktree).'); })).trim();
  if (path.resolve(top) !== path.resolve(root)) throw new Error('Run oasis attempts from the repository root (' + top + ').');
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=no'], env)).trim();
  if (dirty && options.apply) throw new Error('--apply needs a clean checkout of tracked files so the winning patch applies exactly. Commit or stash your changes first.');
  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + '-' + randomBytes(2).toString('hex');
  const dir = path.join(root, ATTEMPTS_DIR, runId);
  await mkdir(dir, { recursive: true });
  await excludeAttemptsDir(root, env);
  // Attempts share the main checkout's installed dependencies (like Cursor's
  // worktree setup) so the verify command can run without a fresh install.
  let configured = {};
  try { configured = (await (await import('./settings.mjs')).loadSettings(root, { env, skipPlugins: true })).worktree || {}; } catch {}
  const shared = [...new Set([...(Array.isArray(configured.symlinkDirectories) ? configured.symlinkDirectories : []), ...((await lstat(path.join(root, 'node_modules')).catch(() => null))?.isDirectory() ? ['node_modules'] : [])])];
  const plan = planAttempts(options);
  onProgress({ type: 'start', runId, attempts: plan.length, dirty: Boolean(dirty) });
  const results = await mapLimit(plan, options.concurrency || plan.length, async (entry) => {
    const started = Date.now();
    let worktree = null;
    const record = { index: entry.index, model: entry.model, worktree: null, agent: null, diff: null, verify: null, tamper: [], error: null };
    try {
      worktree = await createWorktree(root, 'attempt-' + entry.index, { env, worktreeSettings: { ...configured, symlinkDirectories: shared }, signal });
      record.worktree = worktree.relative;
      record.branch = worktree.branch;
      onProgress({ type: 'attempt_started', index: entry.index, model: entry.model, worktree: worktree.relative });
      record.agent = await runAttempt({ worktree, prompt: options.prompt, model: entry.model, options, env, signal, index: entry.index });
      const { patch, stats } = await captureAttemptPatch(worktree, env);
      record.diff = stats;
      record.patch = path.join(ATTEMPTS_DIR, runId, 'attempt-' + entry.index + '.patch').split(path.sep).join('/');
      await writeFile(path.join(root, record.patch), patch);
      record.tamper = analyzeTestDiff(patch.toString('utf8'));
      if (options.verify && stats.changed > 0 && !(signal && signal.aborted)) {
        const check = await runAutoTest(worktree.path, options.verify, { env, signal, timeoutMs: (options.verifyTimeoutSeconds || 900) * 1000 });
        record.verify = { command: check.command, passed: check.passed, exitCode: check.exitCode, timedOut: check.timedOut, durationMs: check.durationMs, output: check.output.slice(-4000) };
      }
    } catch (error) {
      record.error = String(error && error.message || error).slice(0, 2000);
    } finally {
      record.durationMs = Date.now() - started;
      if (worktree && !options.keep) await removeWorktree(root, worktree, { env, deleteBranch: true }).catch(() => {});
      onProgress({ type: 'attempt_finished', index: entry.index, record });
    }
    return record;
  });
  const ranked = rankAttempts(results);
  const winner = pickWinner(ranked);
  let applied = null;
  if (options.apply && winner) {
    const patchFile = path.join(root, winner.patch);
    try {
      await git(root, ['apply', '--check', '--binary', patchFile], env);
      await git(root, ['apply', '--binary', patchFile], env);
      applied = { index: winner.index, patch: winner.patch };
    } catch (error) {
      applied = { index: winner.index, error: String(error.message || error).slice(0, 1000) };
    }
  }
  const report = {
    runId, prompt: options.prompt, verify: options.verify || null, createdAt: new Date().toISOString(),
    winner: winner ? winner.index : null, applied,
    attempts: ranked.map(({ agent, ...rest }) => ({ ...rest, agent: agent ? { ...agent, log: undefined } : null }))
  };
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return { runId, dir: path.join(ATTEMPTS_DIR, runId).split(path.sep).join('/'), ranked, winner, applied, report };
}

export function formatAttemptsReport(outcome, options) {
  const lines = [];
  lines.push('Attempts for: ' + options.prompt.slice(0, 120));
  lines.push(options.verify ? 'Verified with: ' + options.verify : 'No --verify command: attempts are ranked by diff size and the agent\'s own report, and none counts as verified.');
  lines.push('');
  for (const r of outcome.ranked) {
    const status = r.error ? 'error: ' + r.error.split('\n')[0].slice(0, 100)
      : !r.diff || !r.diff.changed ? 'no changes'
        : [
          r.verify ? (r.verify.passed ? 'check passed' : r.verify.timedOut ? 'check timed out' : 'check failed (exit ' + r.verify.exitCode + ')') : 'not checked',
          r.tamper.length ? 'weakened tests: ' + r.tamper.map((t) => t.file + ' ' + t.reason).join('; ').slice(0, 160) : '',
          r.agent && r.agent.isError ? 'agent ' + (r.agent.subtype || 'error') : ''
        ].filter(Boolean).join(', ');
    const size = r.diff ? r.diff.files + ' file' + (r.diff.files === 1 ? '' : 's') + ' +' + r.diff.added + '/-' + r.diff.removed : '-';
    lines.push((r.verified && outcome.winner && r.index === outcome.winner.index ? '* ' : '  ') + '#' + r.index + (r.model ? ' [' + r.model + ']' : '') + '  ' + size + '  ' + Math.round((r.durationMs || 0) / 1000) + 's  ' + status);
  }
  lines.push('');
  if (outcome.winner) {
    lines.push('Winner: attempt #' + outcome.winner.index + '.');
    if (outcome.applied && !outcome.applied.error) lines.push('Applied ' + outcome.applied.patch + ' to your checkout. Review with git diff.');
    else if (outcome.applied && outcome.applied.error) lines.push('Could not apply the winning patch: ' + outcome.applied.error.split('\n')[0] + '. It is saved at ' + outcome.winner.patch + '.');
    else lines.push('Apply it with: git apply ' + outcome.winner.patch);
  } else {
    lines.push(options.verify ? 'No attempt passed the check without weakening tests, so nothing was applied.' : 'Nothing was applied. Pass --verify "your test command" to let OASIS pick and apply a winner.');
  }
  lines.push('Patches and report: ' + outcome.dir + '/');
  return lines.join('\n') + '\n';
}
