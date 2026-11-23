// bisect_regression: find the commit that broke a check.
//
// "It used to work" is a search problem, and git already has the search:
// git bisect. Agents rarely run it, because it checks out old commits in the
// user's folder and needs a person to say good or bad at every step. This tool
// runs it in a private, detached worktree under .oasis/bisect/, so the user's
// files, index and branch are never touched, and lets the check decide every
// step:
//
//   exit 0            good
//   exit 125          skip (cannot be tested at this commit), as in git bisect run
//   any other exit    bad
//   timeout           bad, unless timeout_is_skip
//
// It first confirms that the check fails at `bad` and passes at `good`; a
// check that fails on both, or passes on both, has nothing to bisect and is
// reported as such (often a flaky test or a broken environment). Dependency
// folders (node_modules, .venv, venv, vendor/bundle) are linked from the
// workspace so old commits run without a fresh install; when the dependencies
// themselves changed, the step may be skipped or misjudged, which the report
// mentions. The result names the first bad commit, its subject, author date
// and changed files, with every step's verdict.
//
// Every run goes through runWorkspaceCommand (permission rules, risk analysis,
// the OS sandbox, cancellation). One approval covers the whole search.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { splitSimpleCommandLine } from './tool-aliases.mjs';

export const BISECT_TOOL_DEFINITION = { type: 'function', function: {
  name: 'bisect_regression',
  description: 'Find the exact commit that broke a check ("it used to work"). Runs git bisect in a private worktree (your files, index and branch are not touched): the check decides each step (exit 0 good, 125 skip, anything else bad). Confirms first that the check passes at `good` and fails at `bad`. Returns the first bad commit with its subject, date and changed files, plus every step. Use it when a test or build that passed at an earlier commit, tag or release now fails, before reading code to guess the cause. Dependency folders (node_modules, .venv) are linked from the workspace.',
  parameters: { type: 'object', properties: {
    command: { type: 'string', description: 'The check, as one simple command line (e.g. "npm test", "pytest -q tests/test_api.py::test_login", "go test ./pkg/auth"). The narrowest check that shows the failure is fastest.' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments, when command is only the program name' },
    good: { type: 'string', description: 'A commit, tag or branch where the check passed (e.g. "v1.4.0", "HEAD~20", a SHA)' },
    bad: { type: 'string', description: 'Where it fails; default HEAD (the committed state, not uncommitted edits)' },
    timeout_seconds: { type: 'integer', description: 'Per step, 5-600; default 120' },
    timeout_is_skip: { type: 'boolean', description: 'Treat a step that times out as untestable instead of bad (default false)' },
    max_steps: { type: 'integer', description: '1-40; default 30' }
  }, required: ['command', 'good'], additionalProperties: false } } };

const LINK_DIRS = ['node_modules', '.venv', 'venv', path.join('vendor', 'bundle')];
const REV = /^(?!-)[\w./~^@{}:+-]{1,200}$/;

function git(cwd, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0 });
    });
  });
}

async function revParse(root, rev) {
  const result = await git(root, ['rev-parse', '--verify', '--quiet', rev + '^{commit}']);
  return result.ok ? result.stdout.trim() : '';
}

/** Reads "<sha> is the first bad commit" from git bisect output. */
export function firstBadFromOutput(text) {
  const match = /^([0-9a-f]{7,64}) is the first bad commit/m.exec(String(text || ''));
  return match ? match[1] : '';
}

/** The candidates git leaves when skipped commits hide the answer. */
export function ambiguousFromOutput(text) {
  if (!/There are only 'skip'ped commits left to test|The first bad commit could be any of/.test(String(text || ''))) return [];
  return [...String(text).matchAll(/^([0-9a-f]{40})$/gm)].map((match) => match[1]);
}

function verdictOf(result, { timeoutIsSkip }) {
  if (!result || result.approved === false) return 'denied';
  if (result.cancelled) return 'cancelled';
  if (result.timedOut) return timeoutIsSkip ? 'skip' : 'bad';
  if (result.exitCode === 0) return 'good';
  if (result.exitCode === 125) return 'skip';
  return 'bad';
}

function tail(text, limit = 400) {
  const value = String(text || '').trim();
  return value.length > limit ? '…' + value.slice(-limit) : value;
}

export async function runBisect(root, args = {}, options = {}) {
  root = path.resolve(root);
  const { runWorkspaceCommand } = options.tools || await import('./tools.mjs');
  const argv = Array.isArray(args.args) && args.args.length ? [String(args.command || ''), ...args.args.map(String)] : splitSimpleCommandLine(args.command);
  if (!argv || !argv[0]) throw new Error('bisect_regression needs one simple command line without pipes, && or redirects (for example "npm test"), or command plus args.');
  const good = String(args.good || '').trim();
  const bad = String(args.bad || 'HEAD').trim();
  if (!REV.test(good) || !REV.test(bad)) throw new Error('good and bad must be commit SHAs, tags, branches or expressions like HEAD~10.');
  if (!(await git(root, ['rev-parse', '--is-inside-work-tree'])).ok) throw new Error('This workspace is not a git repository, so there is no history to bisect.');
  const topLevel = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim() || root;
  const goodSha = await revParse(root, good);
  const badSha = await revParse(root, bad);
  if (!goodSha) return { ok: false, message: 'Cannot find the good revision "' + good + '" in this repository.' };
  if (!badSha) return { ok: false, message: 'Cannot find the bad revision "' + bad + '" in this repository.' };
  if (goodSha === badSha) return { ok: false, message: 'good and bad are the same commit; nothing to search.' };
  if (!(await git(root, ['merge-base', '--is-ancestor', goodSha, badSha])).ok) return { ok: false, message: 'The good commit is not an ancestor of the bad one, so git bisect cannot order them. Pick a good revision from the history of ' + bad + '.' };
  const count = Number.parseInt((await git(root, ['rev-list', '--count', goodSha + '..' + badSha])).stdout.trim(), 10) || 0;
  const expectedSteps = Math.max(1, Math.ceil(Math.log2(count + 1)));
  const maxSteps = Math.max(1, Math.min(40, Number.parseInt(args.max_steps, 10) || 30));
  const timeoutSeconds = Math.max(5, Math.min(600, Number.parseInt(args.timeout_seconds, 10) || 120));
  const timeoutIsSkip = args.timeout_is_skip === true;
  // Where the command runs relative to the top level, so a check started in a
  // subfolder of a monorepo runs in the same subfolder of each old commit.
  const subdir = path.relative(topLevel, root);
  const commandText = argv.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');

  const hold = options.injectionHold || '';
  if (hold || (!options.autoApprove && !options.ruleAllowed)) {
    const ok = options.approval && await options.approval('Bisect ' + count + ' commit(s) between ' + good + ' and ' + bad + '?\n  ' + commandText + '\nruns about ' + (expectedSteps + 2) + ' times in a private worktree under .oasis/bisect (your files and branch are not touched).' + (hold ? '\nHIGH RISK: needs a person because ' + hold + '.' : ''), Boolean(hold));
    if (!ok) return { approved: false, message: 'The bisect was not approved. Nothing ran. Do not ask again this turn.' };
  }

  const base = path.join(topLevel, '.oasis', 'bisect');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, '.gitignore'), '# OASIS bisect worktrees\n*\n', { flag: 'wx' }).catch(() => {});
  const worktree = path.join(base, Date.now().toString(36) + '-' + randomBytes(3).toString('hex'));
  const added = await git(topLevel, ['worktree', 'add', '--detach', '--quiet', worktree, badSha]);
  if (!added.ok) return { ok: false, message: 'Could not create a worktree for the bisect: ' + tail(added.stderr) };

  const linked = [];
  const linkDeps = async () => {
    for (const dir of LINK_DIRS) {
      const source = path.join(root, dir);
      const target = path.join(worktree, subdir, dir);
      if (!existsSync(source) || existsSync(target)) continue;
      try { await mkdir(path.dirname(target), { recursive: true }); await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir'); if (!linked.includes(dir)) linked.push(dir); } catch { /* old commit without that folder's parent */ }
    }
  };
  const unlinkDeps = async () => {
    for (const dir of linked) await rm(path.join(worktree, subdir, dir), { force: true, recursive: false }).catch(() => {});
  };
  const runAt = async (sha) => {
    await unlinkDeps();
    const checkout = await git(worktree, ['checkout', '--detach', '--force', '--quiet', sha]);
    if (!checkout.ok) return { verdict: 'skip', error: tail(checkout.stderr) };
    await git(worktree, ['clean', '-fdq', '-e', '.oasis']);
    await linkDeps();
    const cwd = path.join(worktree, subdir);
    if (!existsSync(cwd)) return { verdict: 'skip', error: 'the folder ' + subdir + ' does not exist at this commit' };
    const started = Date.now();
    const result = await runWorkspaceCommand(cwd, argv[0], argv.slice(1), {
      approval: options.approval, autoApprove: true, ruleAllowed: Boolean(options.ruleAllowed), env: options.env || process.env,
      signal: options.signal, sandbox: options.sandbox, persistOutputLogs: false, timeoutToBackground: false, timeoutSeconds
    });
    return { verdict: verdictOf(result, { timeoutIsSkip }), exitCode: Number.isInteger(result && result.exitCode) ? result.exitCode : null, seconds: Math.round((Date.now() - started) / 100) / 10, output: tail((result && (result.stderr || result.stdout)) || '') };
  };
  const describe = async (sha) => {
    const log = await git(root, ['show', '-s', '--format=%H%x00%s%x00%an%x00%aI', sha]);
    const [full, subject, author, date] = log.stdout.trim().split('\0');
    const files = (await git(root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', sha])).stdout.trim().split('\n').filter(Boolean).slice(0, 60);
    return { sha: full || sha, short: (full || sha).slice(0, 12), subject, author, date, files };
  };

  const steps = [];
  try {
    // Endpoints first: a search needs a pass and a fail.
    const atBad = await runAt(badSha);
    steps.push({ commit: badSha.slice(0, 12), role: 'bad', ...atBad });
    if (atBad.verdict === 'denied' || atBad.verdict === 'cancelled') return { ok: false, steps, message: atBad.verdict === 'cancelled' ? 'Cancelled.' : 'The check was not approved.' };
    if (atBad.verdict !== 'bad') return { ok: false, steps, message: atBad.verdict === 'good' ? 'The check passes at ' + bad + ' in a clean checkout. If it fails in your folder, the cause is in uncommitted changes or local files, not in history (see git status and git diff).' : 'The check cannot run at ' + bad + ' (exit 125 or checkout failed).' };
    const atGood = await runAt(goodSha);
    steps.push({ commit: goodSha.slice(0, 12), role: 'good', ...atGood });
    if (atGood.verdict === 'cancelled') return { ok: false, steps, message: 'Cancelled.' };
    if (atGood.verdict !== 'good') return { ok: false, steps, message: 'The check also fails at ' + good + ', so nothing changed between the two. Try an older good revision; if it fails everywhere, the cause is the environment (dependencies, services, flaky test) rather than a commit.' };

    let state = await git(worktree, ['bisect', 'start', '--no-checkout', badSha, goodSha]);
    if (!state.ok) return { ok: false, steps, message: 'git bisect start failed: ' + tail(state.stderr) };
    let output = state.stdout;
    let firstBad = '';
    for (let step = 0; step < maxSteps; step += 1) {
      firstBad = firstBadFromOutput(output);
      if (firstBad || ambiguousFromOutput(output).length) break;
      const current = (await git(worktree, ['rev-parse', 'BISECT_HEAD'])).stdout.trim();
      if (!current) break;
      const outcome = await runAt(current);
      steps.push({ commit: current.slice(0, 12), ...outcome });
      if (outcome.verdict === 'cancelled' || outcome.verdict === 'denied') return { ok: false, cancelled: true, steps, message: 'Stopped before the search finished.' };
      state = await git(worktree, ['bisect', outcome.verdict, current]);
      output = state.stdout + '\n' + state.stderr;
    }
    firstBad = firstBad || firstBadFromOutput(output);
    const ambiguous = ambiguousFromOutput(output);
    const skipped = steps.filter((item) => item.verdict === 'skip').length;
    if (!firstBad) {
      return {
        ok: false, steps, ...(ambiguous.length ? { candidates: await Promise.all(ambiguous.slice(0, 10).map(describe)) } : {}),
        message: ambiguous.length ? 'Skipped commits hide the answer: the first bad commit is one of the candidates.' : 'The search stopped after ' + steps.length + ' steps without an answer; raise max_steps.'
      };
    }
    const commit = await describe(firstBad);
    const notes = [];
    if (skipped) notes.push(skipped + ' commit(s) could not be tested and were skipped.');
    if (linked.length) notes.push('Dependencies were linked from the workspace (' + linked.join(', ') + '); if the first bad commit only changes dependency manifests, rerun after installing at that commit.');
    return {
      ok: true, command: commandText, good: goodSha.slice(0, 12), bad: badSha.slice(0, 12), commits_in_range: count,
      first_bad_commit: commit, steps,
      next: 'Read the change with git_diff or `git show ' + commit.short + '`; the failure most likely comes from one of its files.',
      ...(notes.length ? { notes: notes.join(' ') } : {})
    };
  } finally {
    await git(worktree, ['bisect', 'reset']).catch(() => {});
    await unlinkDeps();
    await git(topLevel, ['worktree', 'remove', '--force', worktree]);
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
    await git(topLevel, ['worktree', 'prune']);
  }
}
