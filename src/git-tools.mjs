// Git workflow tools: git_log (read-only), git_commit, git_branch, git_push and
// create_pull_request (through the GitHub CLI). Every change asks for approval
// unless commands are auto-approved or a permission rule allows the tool.
//
// OASIS Git safety policy:
//   - never force-push, never rewrite history (no amend, rebase, or reset)
//   - never skip hooks (no --no-verify) and never change git config
//   - refuse to commit files that look like secrets (.env, keys, credentials)
//   - commit messages are passed on stdin, never through a shell
import { spawn } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import path from 'node:path';
import { inspectWorktree, mergeWorktree } from './worktrees.mjs';

const workspaceTools = () => import('./tools.mjs');
const MAX_OUTPUT = 24 * 1024;

export const GIT_TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'worktree_inspect', description: 'Read-only preflight for an OASIS subagent worktree. Reports changed paths, overlapping files, dirty checkouts and Git-predicted merge conflicts.', parameters: { type: 'object', properties: { branch: { type: 'string', description: 'OASIS-managed worktree branch returned by the subagent' } }, required: ['branch'], additionalProperties: false } } },
  { type: 'function', function: { name: 'worktree_merge', description: 'Approval-gated merge of a reviewed OASIS worktree. Requires clean checkouts and a conflict-free Git preview. If same paths changed on both sides, inspect first and set allow_overlaps=true only after deciding to accept the conflict-free merge. Predicted conflicts are never merged.', parameters: { type: 'object', properties: { branch: { type: 'string', description: 'OASIS worktree branch to merge' }, allow_overlaps: { type: 'boolean', description: 'Explicitly acknowledge conflict-free overlapping path changes; default false' } }, required: ['branch'], additionalProperties: false } } },

  { type: 'function', function: { name: 'git_log', description: 'Read recent Git commits (hash, author, date, subject). Read-only. Use before committing to match the repository\'s message style.', parameters: { type: 'object', properties: {
    limit: { type: 'integer', description: 'Number of commits, 1-200; default 20' },
    ref: { type: 'string', description: 'Branch, tag, or range such as main..HEAD; default HEAD' },
    path: { type: 'string', description: 'Only commits touching this workspace-relative path' }
  }, required: [] } } },
  { type: 'function', function: { name: 'git_commit', description: 'Stage changes and create a Git commit. Without paths, stages every change in the working tree (git add -A); with paths, stages only those. Refuses to commit secret-looking files, never amends, and never skips hooks. Write a concise message in the repository\'s style: a summary line under 72 characters, a blank line, then why the change was made. Requires approval.', parameters: { type: 'object', properties: {
    message: { type: 'string', description: 'Full commit message' },
    paths: { type: 'array', maxItems: 200, items: { type: 'string' }, description: 'Optional workspace-relative files or folders to stage; default all changes' }
  }, required: ['message'] } } },
  { type: 'function', function: { name: 'git_branch', description: 'Create a Git branch (from the current HEAD or from a given ref) and switch to it, or switch to an existing branch. Requires approval.', parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'Branch name, for example feature/login-form' },
    from: { type: 'string', description: 'Optional start point (branch, tag, or commit) for a new branch' },
    checkout: { type: 'boolean', description: 'Switch to the branch; default true' }
  }, required: ['name'] } } },
  { type: 'function', function: { name: 'git_push', description: 'Push the current branch to a remote and set its upstream. Never force-pushes. Requires approval.', parameters: { type: 'object', properties: {
    remote: { type: 'string', description: 'Remote name; default origin' }
  }, required: [] } } },
  { type: 'function', function: { name: 'create_pull_request', description: 'Push the current branch and open a GitHub pull request with the GitHub CLI (gh). Write a short title and a body with a summary and a test plan. Requires approval and an authenticated gh.', parameters: { type: 'object', properties: {
    title: { type: 'string' },
    body: { type: 'string', description: 'Markdown description: summary of changes and how they were tested' },
    base: { type: 'string', description: 'Target branch; default the repository default branch' },
    draft: { type: 'boolean', description: 'Open as a draft; default false' }
  }, required: ['title', 'body'] } } }
];

export const GIT_TOOL_NAMES = GIT_TOOL_DEFINITIONS.map((tool) => tool.function.name);

// Network operations (push, gh) keep the variables those tools authenticate with.
const AUTH_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH_COMMAND', 'GIT_SSH'];

async function commandEnv(source, network) {
  const { scrubEnvironment } = await workspaceTools();
  const env = { ...scrubEnvironment(source), GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  if (network) for (const key of AUTH_ENV) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

function run(command, args, { cwd, env, input, timeout = 60000, signal } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let interrupted = false;
    let timedOut = false;
    let killTimer = null;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A timed-out/cancelled leader may close its pipes before a descendant.
      if (!interrupted) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', abort);
      resolve({ ...result, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const terminate = (kind) => {
      interrupted = true;
      if (kind === 'timeout') timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        killTimer = null;
        signalProcessTree(child, 'SIGKILL');
      }, 750);
      killTimer.unref?.();
    };
    const abort = () => terminate('cancel');
    const timer = setTimeout(() => terminate('timeout'), timeout);
    timer.unref?.();
    try {
      child = spawn(command, args, {
        cwd, env, shell: false, windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...processTreeSpawnOptions()
      });
    } catch (error) { finish({ exitCode: 127, error: error.message }); return; }
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT); });
    child.on('error', (error) => finish({ exitCode: 127, error: error.code === 'ENOENT' ? command + ' is not installed or not on PATH.' : error.message, ...(timedOut ? { timedOut: true, exitCode: 124 } : {}), ...(signal && signal.aborted ? { cancelled: true } : {}) }));
    child.on('close', (code) => finish({
      exitCode: timedOut ? 124 : (code ?? 1),
      ...(timedOut ? { timedOut: true } : {}),
      ...(signal && signal.aborted ? { cancelled: true } : {})
    }));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

const git = (root, args, options = {}) => run('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args], { cwd: root, ...options });

function fail(message, extra = {}) { return { ok: false, message, ...extra }; }

async function approve(options, message) {
  if (options.autoApprove || options.ruleAllowed) return true;
  return Boolean(options.approval && await options.approval(message));
}

async function currentBranch(root, env) {
  const out = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { env });
  return out.exitCode === 0 ? out.stdout : null;
}

async function ensureRepository(root, env) {
  const out = await git(root, ['rev-parse', '--is-inside-work-tree'], { env });
  if (out.exitCode !== 0 || out.stdout !== 'true') throw new Error('This workspace is not a Git repository.');
}

function validRefPart(value, label) {
  const text = String(value || '').trim();
  if (!text || text.startsWith('-') || /[\s~^:?*\[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|\.lock$|\/$|\.$/.test(text)) throw new Error('Invalid ' + label + ': ' + JSON.stringify(text));
  return text;
}

// Parse `git status --porcelain=v1 -z`.
function parseStatus(raw) {
  const entries = [];
  const parts = String(raw || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    let from = null;
    if (status[0] === 'R' || status[0] === 'C') from = parts[++i];
    entries.push({ status, file, ...(from ? { from } : {}) });
  }
  return entries;
}

function describeStatus(status) {
  if (status === '??') return 'new';
  const code = status[0] !== ' ' ? status[0] : status[1];
  return { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict' }[code] || status.trim();
}

function within(file, prefixes) {
  if (!prefixes.length) return true;
  return prefixes.some((prefix) => prefix === '.' || file === prefix || file.startsWith(prefix.replace(/\/+$/, '') + '/'));
}

// ---------------------------------------------------------------- tools
async function gitLog(root, args, options) {
  const env = await commandEnv(options.env || process.env, false);
  await ensureRepository(root, env);
  const limit = Math.max(1, Math.min(200, Number.parseInt(args.limit, 10) || 20));
  const commandArgs = ['log', '--no-color', '--date=short', '--format=%h%x09%an%x09%ad%x09%s', '-n', String(limit)];
  if (args.ref) commandArgs.push(validRefPart(args.ref, 'ref'));
  commandArgs.push('--');
  if (args.path) {
    const { resolveWorkspacePath } = await workspaceTools();
    const target = await resolveWorkspacePath(root, String(args.path));
    commandArgs.push(path.relative(target.root, target.absolute) || '.');
  }
  const out = await git(root, commandArgs, { env, signal: options.signal });
  if (out.exitCode !== 0) return fail(out.stderr || 'git log failed.', { exitCode: out.exitCode });
  const commits = out.stdout ? out.stdout.split('\n').map((line) => { const [hash, author, date, ...subject] = line.split('\t'); return { hash, author, date, subject: subject.join('\t') }; }) : [];
  return { ok: true, branch: await currentBranch(root, env), commits, count: commits.length };
}

async function gitCommit(root, args, options) {
  const { resolveWorkspacePath, sensitivePath } = await workspaceTools();
  const env = await commandEnv(options.env || process.env, false);
  await ensureRepository(root, env);
  const message = String(args.message || '').replace(/\r\n/g, '\n').trim();
  if (!message) return fail('A commit message is required.');
  if (message.length > 10000) return fail('The commit message is too long.');
  const prefixes = [];
  for (const item of Array.isArray(args.paths) ? args.paths.slice(0, 200) : []) {
    const target = await resolveWorkspacePath(root, String(item));
    prefixes.push((path.relative(target.root, target.absolute) || '.').split(path.sep).join('/'));
  }
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env });
  if (status.exitCode !== 0) return fail(status.stderr || 'git status failed.');
  const entries = parseStatus(status.stdout);
  if (entries.some((entry) => entry.status.includes('U'))) return fail('The repository has unresolved merge conflicts. Resolve them before committing.');
  // Already-staged files are committed too, so they count toward the secret check.
  const selected = entries.filter((entry) => entry.status[0] !== ' ' && entry.status[0] !== '?' || within(entry.file, prefixes));
  if (!selected.length) return fail('There is nothing to commit' + (prefixes.length ? ' under ' + prefixes.join(', ') : '') + '.');
  const secrets = selected.filter((entry) => !entry.status.includes('D') && sensitivePath(entry.file)).map((entry) => entry.file);
  if (secrets.length) return fail('Refusing to commit files that look like secrets: ' + secrets.join(', ') + '. Add them to .gitignore, or commit them yourself if this is intentional.', { blocked: secrets });
  const branch = await currentBranch(root, env);
  const lines = selected.slice(0, 40).map((entry) => '  ' + describeStatus(entry.status).padEnd(9) + ' ' + entry.file);
  if (selected.length > 40) lines.push('  … and ' + (selected.length - 40) + ' more');
  const ok = await approve(options, 'Create a Git commit on ' + (branch || 'a detached HEAD') + ' with ' + selected.length + ' file(s)?\n' + lines.join('\n') + '\n\nMessage:\n' + message.split('\n').map((line) => '  ' + line).join('\n'));
  if (!ok) return fail('The commit was not approved. Nothing was staged or committed.', { approved: false });
  const add = await git(root, ['add', '-A', '--', ...(prefixes.length ? prefixes : ['.'])], { env, signal: options.signal });
  if (add.exitCode !== 0) return fail('git add failed: ' + (add.stderr || add.error || ''), { exitCode: add.exitCode });
  const commit = await git(root, ['commit', '--file=-', '--cleanup=strip'], { env, input: message + '\n', timeout: 300000, signal: options.signal });
  if (commit.exitCode !== 0) {
    // The changes stay staged; a later git_commit picks them up again.
    return fail('git commit failed. If a Git hook (pre-commit, commit-msg) rejected it, fix the reported problems and commit again; do not skip hooks.', { exitCode: commit.exitCode, output: (commit.stdout + '\n' + commit.stderr).trim().slice(-6000) });
  }
  const head = await git(root, ['log', '-1', '--format=%h%x09%s'], { env });
  const stat = await git(root, ['show', '--stat', '--format=', '--no-color', 'HEAD'], { env });
  const [hash, subject] = head.stdout.split('\t');
  return { ok: true, commit: hash, subject, branch, files: selected.length, stat: stat.stdout.slice(-4000), ...(commit.stdout.includes('hook') ? { output: commit.stdout.slice(-2000) } : {}) };
}

async function gitBranch(root, args, options) {
  const env = await commandEnv(options.env || process.env, false);
  await ensureRepository(root, env);
  const name = validRefPart(args.name, 'branch name');
  const check = await git(root, ['check-ref-format', '--branch', name], { env });
  if (check.exitCode !== 0) return fail('Invalid branch name: ' + name);
  const from = args.from ? validRefPart(args.from, 'start point') : null;
  const checkout = args.checkout !== false;
  const exists = (await git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name], { env })).exitCode === 0;
  if (exists && from) return fail('Branch ' + name + ' already exists; omit from to switch to it.');
  const current = await currentBranch(root, env);
  if (exists && current === name) return { ok: true, branch: name, created: false, message: 'Already on ' + name + '.' };
  const action = exists ? 'Switch to existing branch ' + name : 'Create branch ' + name + ' from ' + (from || current || 'HEAD') + (checkout ? ' and switch to it' : '');
  if (!await approve(options, action + '?')) return fail('The branch change was not approved.', { approved: false });
  const commandArgs = exists ? ['switch', name] : checkout ? ['switch', '-c', name, ...(from ? [from] : [])] : ['branch', name, ...(from ? [from] : [])];
  const out = await git(root, commandArgs, { env, signal: options.signal });
  if (out.exitCode !== 0) return fail((out.stderr || 'git ' + commandArgs[0] + ' failed.').slice(-4000), { exitCode: out.exitCode });
  return { ok: true, branch: name, created: !exists, switched: checkout || exists, previous: current };
}

async function pushBranch(root, remote, env, options) {
  const branch = await currentBranch(root, env);
  if (!branch) return fail('HEAD is detached; create a branch first with git_branch.');
  const remotes = await git(root, ['remote'], { env });
  if (!remotes.stdout.split('\n').includes(remote)) return fail('There is no Git remote named ' + remote + '.');
  const out = await git(root, ['push', '--set-upstream', remote, 'HEAD:refs/heads/' + branch], { env, timeout: 300000, signal: options.signal });
  if (out.exitCode !== 0) {
    const hint = /rejected|non-fast-forward|fetch first/i.test(out.stderr) ? ' The remote has commits you do not have; pull or rebase first. Oasis never force-pushes.' : /auth|permission|403|could not read/i.test(out.stderr) ? ' Check that Git is signed in to this remote.' : '';
    return fail('git push failed.' + hint, { exitCode: out.exitCode, output: out.stderr.slice(-4000) });
  }
  return { ok: true, branch, remote, output: (out.stderr || out.stdout).slice(-2000) };
}

async function gitPush(root, args, options) {
  const env = await commandEnv(options.env || process.env, true);
  await ensureRepository(root, env);
  const remote = validRefPart(args.remote || 'origin', 'remote');
  const branch = await currentBranch(root, env);
  if (!branch) return fail('HEAD is detached; create a branch first with git_branch.');
  const ahead = await git(root, ['log', '--oneline', '--no-color', '@{upstream}..HEAD'], { env });
  const pending = ahead.exitCode === 0 ? ahead.stdout.split('\n').filter(Boolean) : null;
  if (pending && !pending.length) return { ok: true, branch, remote, message: 'Nothing to push; ' + branch + ' is up to date with its upstream.' };
  const summary = pending ? pending.length + ' commit(s):\n' + pending.slice(0, 20).map((line) => '  ' + line).join('\n') : '(no upstream yet; the whole branch will be published)';
  if (!await approve(options, 'Push ' + branch + ' to ' + remote + '? ' + summary)) return fail('The push was not approved.', { approved: false });
  return await pushBranch(root, remote, env, options);
}

async function createPullRequest(root, args, options) {
  const env = await commandEnv(options.env || process.env, true);
  await ensureRepository(root, env);
  const title = String(args.title || '').trim();
  const body = String(args.body || '').trim();
  if (!title) return fail('A pull request title is required.');
  const gh = await run('gh', ['--version'], { cwd: root, env, timeout: 10000 });
  if (gh.exitCode !== 0) return fail('The GitHub CLI (gh) is required to open pull requests. Install it from https://cli.github.com and run gh auth login.');
  const branch = await currentBranch(root, env);
  if (!branch) return fail('HEAD is detached; create a branch first with git_branch.');
  let base = args.base ? validRefPart(args.base, 'base branch') : null;
  if (!base) {
    const view = await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd: root, env, timeout: 30000 });
    base = view.exitCode === 0 && view.stdout ? view.stdout : null;
    if (!base) {
      const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { env });
      base = head.exitCode === 0 ? head.stdout.replace(/^origin\//, '') : 'main';
    }
  }
  if (branch === base) return fail('You are on ' + base + ', the base branch. Create a feature branch with git_branch, commit there, then open the pull request.');
  const dirty = await git(root, ['status', '--porcelain=v1', '--untracked-files=no'], { env });
  const commits = await git(root, ['log', '--oneline', '--no-color', 'origin/' + base + '..HEAD'], { env });
  const list = commits.exitCode === 0 ? commits.stdout.split('\n').filter(Boolean) : [];
  if (commits.exitCode === 0 && !list.length) return fail('There are no commits on ' + branch + ' that are not on ' + base + '. Commit your changes first.');
  const prompt = 'Push ' + branch + ' and open a ' + (args.draft ? 'draft ' : '') + 'pull request into ' + base + '?\n  Title: ' + title +
    (list.length ? '\n  Commits:\n' + list.slice(0, 15).map((line) => '    ' + line).join('\n') : '') +
    (dirty.stdout ? '\n  Note: uncommitted changes will not be included.' : '');
  if (!await approve(options, prompt)) return fail('Opening the pull request was not approved.', { approved: false });
  const pushed = await pushBranch(root, 'origin', env, options);
  if (!pushed.ok) return pushed;
  const out = await run('gh', ['pr', 'create', '--title', title, '--body-file', '-', '--base', base, '--head', branch, ...(args.draft ? ['--draft'] : [])], { cwd: root, env, input: body + '\n', timeout: 120000, signal: options.signal });
  if (out.exitCode !== 0) {
    const existing = /already exists/i.test(out.stderr) ? (out.stderr.match(/https:\/\/\S+/) || [null])[0] : null;
    if (existing) return { ok: true, url: existing, branch, base, existing: true, message: 'A pull request for ' + branch + ' already exists; the branch was pushed to update it.' };
    return fail('gh pr create failed.', { exitCode: out.exitCode, output: (out.stderr || out.stdout).slice(-4000) });
  }
  const url = (out.stdout.match(/https:\/\/\S+/) || [out.stdout])[0];
  return { ok: true, url, branch, base, draft: Boolean(args.draft), commits: list.length };
}

export async function runGitTool(name, root, args = {}, options = {}) {
  switch (name) {
    case 'worktree_inspect': return await inspectWorktree(root, args.branch, { env: options.env || process.env });
    case 'worktree_merge': {
      const preview = await inspectWorktree(root, args.branch, { env: options.env || process.env });
      if (!preview.main_worktree_clean) return fail('The main checkout has uncommitted changes.', { preview });
      if (!preview.agent_worktree_clean) return fail('The agent worktree has uncommitted changes.', { preview });
      if (!preview.current_branch) return fail('The main checkout is detached.', { preview });
      if (!preview.merge_preview_supported) return fail('Git could not safely preview this merge; it is disabled.', { preview });
      if (preview.merge_conflicts.length) return fail('Git predicts conflicts: ' + preview.merge_conflicts.join(', ') + '. Nothing was merged.', { preview });
      if (preview.overlapping_files.length && args.allow_overlaps !== true) return fail('Both branches changed the same paths: ' + preview.overlapping_files.join(', ') + '. Review them, then retry with allow_overlaps=true only if you accept the conflict-free merge.', { preview });
      if (!await approve(options, 'Merge reviewed OASIS worktree ' + args.branch + ' into ' + preview.current_branch + '? This creates a merge commit.')) return fail('The merge was not approved; no changes were made.', { preview });
      try { return await mergeWorktree(root, args.branch, { env: options.env || process.env, expectedHead: preview.head, allowOverlaps: args.allow_overlaps === true }); }
      catch (error) { return fail(error.message, { preview }); }
    }
    case 'git_log': return await gitLog(root, args, options);
    case 'git_commit': return await gitCommit(root, args, options);
    case 'git_branch': return await gitBranch(root, args, options);
    case 'git_push': return await gitPush(root, args, options);
    case 'create_pull_request': return await createPullRequest(root, args, options);
    default: throw new Error('Unknown git tool ' + name);
  }
}
