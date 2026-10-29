// Session-level tools: deferred MCP tool search, background process monitoring,
// entering plan mode, desktop notifications, and in-session scheduled prompts.
import { spawn } from 'node:child_process';
import { SHARED_TASK_TOOL_DEFINITIONS, SHARED_TASK_TOOL_NAMES, SHARED_TASK_READ_ONLY_TOOL_NAMES, runSharedTaskTool } from './shared-tasks.mjs';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

export const TOOL_SEARCH_DEFINITION = fn('tool_search',
  'Find and load deferred tools (usually MCP tools) by keyword. Use "select:name1,name2" to load exact tools. Loaded tools become callable on your next step.',
  { query: { type: 'string', description: 'Keywords, or select:<comma-separated tool names>.' }, max_results: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']);

export const SESSION_TOOL_DEFINITIONS = [
  fn('terminal_read', 'Read new output from a real PTY terminal session. Use wait_seconds to wait briefly for more data. Keep the returned nextOffset and pass it as offset to avoid repeating old output.',
    { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 48000 }, wait_seconds: { type: 'integer', minimum: 0, maximum: 30 } }, ['id']),
  fn('terminal_list', 'List current-session PTY terminal sessions and their running/exited state. No command arguments or environment values are exposed.', {}),
  fn('terminal_input', 'Send input bytes/text to an existing, already-approved PTY process. Use newline or carriage return when the program needs Enter. The underlying process retains its original permission boundary.',
    { id: { type: 'string' }, data: { type: 'string', maxLength: 16384 } }, ['id', 'data']),
  fn('terminal_resize', 'Resize an active PTY terminal. Columns are clamped to 20–300 and rows to 5–120.',
    { id: { type: 'string' }, cols: { type: 'integer', minimum: 20, maximum: 300 }, rows: { type: 'integer', minimum: 5, maximum: 120 } }, ['id', 'cols', 'rows']),
  fn('terminal_interrupt', 'Send Ctrl+C to an active PTY process. The program may handle or ignore it; use terminal_stop to terminate the process.',
    { id: { type: 'string' } }, ['id']),
  fn('terminal_stop', 'Terminate an active PTY terminal process. Use this when a process should not continue running.',
    { id: { type: 'string' } }, ['id']),
  fn('monitor_command', 'Wait for a background command (started with run_command background=true) until its output matches a pattern, it exits, or the timeout passes. Returns the new output.',
    { id: { type: 'string' }, pattern: { type: 'string', description: 'Optional JavaScript regular expression to wait for.' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 } }, ['id']),
  fn('enter_plan_mode', 'Switch to plan mode for complex or risky work: research read-only, then call exit_plan_mode with a plan for the user to approve.',
    { reason: { type: 'string' } }),
  fn('notify', 'Send the user a desktop or terminal notification, for example when a long task finishes or needs attention.',
    { message: { type: 'string' }, title: { type: 'string' } }, ['message']),
  fn('cron_create', 'Schedule a prompt to run in this session on a 5-field cron schedule (minute hour day-of-month month day-of-week, local time). Jobs end when the session ends.',
    { cron: { type: 'string' }, prompt: { type: 'string' }, recurring: { type: 'boolean', description: 'Default true. false runs once at the next match.' } }, ['cron', 'prompt']),
  fn('cron_list', 'List scheduled prompts in this session.', {}),
  fn('cron_delete', 'Cancel a scheduled prompt by id.', { id: { type: 'string' } }, ['id']),
  fn('enter_worktree', 'Create an isolated git worktree on a new branch and switch this session into it (files, commands and git now act there; the conversation continues). Pass path to switch into an existing worktree of this repository instead. Use exit_worktree to return.',
    { name: { type: 'string', description: 'Short label for the new worktree/branch.' }, path: { type: 'string', description: 'Existing worktree to enter instead of creating one.' } }),
  fn('exit_worktree', 'Leave the worktree entered with enter_worktree and return to the original directory. action "keep" leaves the worktree and branch; "remove" deletes them (refused when there are uncommitted changes or new commits unless discard_changes is true).',
    { action: { type: 'string', enum: ['keep', 'remove'] }, discard_changes: { type: 'boolean' } }, ['action']),
  ...SHARED_TASK_TOOL_DEFINITIONS
];

export const SESSION_TOOL_NAMES = new Set(['tool_search', ...SESSION_TOOL_DEFINITIONS.map((tool) => tool.function.name)]);
export const SESSION_READ_ONLY_TOOLS = ['enter_worktree', 'exit_worktree', 'tool_search', 'terminal_read', 'terminal_list', 'monitor_command', 'enter_plan_mode', 'notify', 'cron_list', ...SHARED_TASK_READ_ONLY_TOOL_NAMES];
export const DEFAULT_TOOL_SEARCH_THRESHOLD = 25;

// Defer MCP tools when there are many of them so they do not crowd the context window.
export function deferMcpTools(session, { threshold = DEFAULT_TOOL_SEARCH_THRESHOLD, env = process.env } = {}) {
  const setting = String(env.OASIS_TOOL_SEARCH || '').toLowerCase();
  if (setting === 'off' || setting === 'false' || setting === '0') return 0;
  const limit = Number(env.OASIS_TOOL_SEARCH_THRESHOLD) > 0 ? Number(env.OASIS_TOOL_SEARCH_THRESHOLD) : threshold;
  const map = session.mcpToolMap;
  if (!map || !map.size) return 0;
  const mcp = session.toolDefinitions.filter((tool) => map.has(tool.function.name));
  if (setting !== 'always' && setting !== 'on' && mcp.length <= limit) return 0;
  session.deferredTools = new Map(mcp.map((tool) => [tool.function.name, tool]));
  session.toolDefinitions = session.toolDefinitions.filter((tool) => !session.deferredTools.has(tool.function.name)).concat([TOOL_SEARCH_DEFINITION]);
  return mcp.length;
}

export function deferredToolsPrompt(session) {
  if (!session.deferredTools || !session.deferredTools.size) return '';
  const names = [...session.deferredTools.keys()];
  return 'Deferred tools (' + names.length + '): ' + names.slice(0, 200).join(', ') + (names.length > 200 ? ', …' : '') + '\nThese are not loaded yet. Call tool_search with keywords or select:<name> to load the ones you need before calling them.';
}

export function searchTools(session, { query, max_results: max = 5 } = {}) {
  const deferred = session.deferredTools || new Map();
  const text = String(query || '').trim();
  if (!text) throw new Error('tool_search needs a query.');
  let matches;
  if (/^select:/i.test(text)) {
    matches = text.slice(7).split(',').map((name) => name.trim()).filter((name) => deferred.has(name));
  } else {
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    matches = [...deferred.values()].map((tool) => {
      const name = tool.function.name.toLowerCase();
      const hay = name + ' ' + String(tool.function.description || '').toLowerCase();
      const score = terms.reduce((total, term) => total + (name.includes(term) ? 3 : 0) + (hay.includes(term) ? 1 : 0), 0);
      return { name: tool.function.name, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(20, Math.max(1, Number(max) || 5))).map((item) => item.name);
  }
  for (const name of matches) {
    session.toolDefinitions.push(deferred.get(name));
    deferred.delete(name);
  }
  return { loaded: matches, remaining_deferred: deferred.size, message: matches.length ? 'Loaded ' + matches.join(', ') + '. They are callable now.' : 'No deferred tools matched. Try other keywords.' };
}

export async function monitorCommand(session, args = {}, { signal } = {}) {
  const entry = session.background && session.background.get(String(args.id || ''));
  if (!entry) throw new Error('No background command with id ' + args.id + '. Use list_background to see ids.');
  let pattern = null;
  if (args.pattern) {
    try { pattern = new RegExp(String(args.pattern).slice(0, 500), 'm'); } catch (error) { throw new Error('Invalid pattern: ' + error.message); }
  }
  const timeoutMs = Math.min(600, Math.max(1, Number(args.timeout_seconds) || 60)) * 1000;
  const started = Date.now();
  const startOffset = entry.readOffset;
  let reason = 'timeout';
  while (Date.now() - started < timeoutMs) {
    if (signal && signal.aborted) { reason = 'interrupted'; break; }
    const fresh = entry.output.slice(Math.min(startOffset, entry.output.length));
    if (pattern && pattern.test(fresh)) { reason = 'matched'; break; }
    if (entry.status !== 'running') { reason = 'exited'; break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const text = entry.output.slice(Math.min(startOffset, entry.output.length));
  entry.readOffset = entry.output.length;
  return { id: entry.id, reason, status: entry.status, exitCode: entry.exitCode, waited_ms: Date.now() - started, output: text.length > 20000 ? '…' + text.slice(-20000) : text };
}

export function enterPlanMode(session, args = {}) {
  session.permissions ||= {};
  if (session.permissions.mode === 'plan') return { mode: 'plan', message: 'Already in plan mode.' };
  session.prePlanMode = session.permissions.mode || 'default';
  if (typeof session.permissions.setMode === 'function') session.permissions.setMode('plan');
  else session.permissions.mode = 'plan';
  return { mode: 'plan', message: 'Plan mode is on' + (args.reason ? ' (' + String(args.reason).slice(0, 200) + ')' : '') + '. Research read-only, then call exit_plan_mode with your plan.' };
}

export function notifyUser(args = {}, { env = process.env, output = process.stderr, platform = process.platform, run = spawnQuiet } = {}) {
  const message = String(args.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
  const title = String(args.title || 'Oasis').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80);
  if (!message) throw new Error('notify needs a message.');
  const channels = [];
  if (output && output.isTTY) {
    output.write('\x1b]9;' + title + ': ' + message + '\x07');
    channels.push('terminal');
  }
  if (env.OASIS_NOTIFY_DESKTOP !== '0') {
    if (platform === 'darwin') { run('osascript', ['-e', 'display notification ' + JSON.stringify(message) + ' with title ' + JSON.stringify(title)]); channels.push('osascript'); }
    else if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) { run('notify-send', [title, message]); channels.push('notify-send'); }
  }
  return { sent: channels.length > 0, channels, message };
}

function spawnQuiet(command, args) {
  try { const child = spawn(command, args, { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); } catch {}
}

// Minimal 5-field cron: *, */n, a-b, a-b/n, lists, and names are not supported.
export function parseCron(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron needs 5 fields: minute hour day-of-month month day-of-week.');
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.map((field, index) => {
    const [min, max] = ranges[index];
    const values = new Set();
    for (const part of field.split(',')) {
      const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!match) throw new Error('Invalid cron field "' + field + '".');
      let [lo, hi] = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
      if (hi === undefined) hi = match[2] ? max : lo;
      const step = match[2] ? Number(match[2]) : 1;
      if (lo < min || hi > max || lo > hi || step < 1) throw new Error('Cron field "' + field + '" is out of range.');
      for (let value = lo; value <= hi; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return values;
  });
}

export function cronMatches(fields, date) {
  return fields[0].has(date.getMinutes()) && fields[1].has(date.getHours()) && fields[2].has(date.getDate()) && fields[3].has(date.getMonth() + 1) && fields[4].has(date.getDay());
}

export function nextCronRun(fields, from = new Date()) {
  const date = new Date(from.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (cronMatches(fields, date)) return date;
    date.setMinutes(date.getMinutes() + 1);
  }
  return null;
}

const MAX_CRON_JOBS = 20;

export function cronState(session) {
  return session.cron ||= { jobs: new Map(), timer: null, onFire: null, nextId: 1 };
}

export function createCronJob(session, args = {}, { now = () => new Date(), startTimer = true } = {}) {
  const state = cronState(session);
  if (state.jobs.size >= MAX_CRON_JOBS) throw new Error('This session already has ' + MAX_CRON_JOBS + ' scheduled prompts.');
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('cron_create needs a prompt.');
  const fields = parseCron(args.cron);
  const id = 'cron_' + state.nextId++;
  const next = nextCronRun(fields, now());
  const job = { id, cron: String(args.cron).trim(), prompt: prompt.slice(0, 4000), recurring: args.recurring !== false, fields, nextRun: next, runs: 0 };
  state.jobs.set(id, job);
  if (startTimer) ensureCronTimer(session);
  return { id, cron: job.cron, recurring: job.recurring, next_run: next ? next.toISOString() : null, message: 'Scheduled. It runs while this session is open.' };
}

export function listCronJobs(session) {
  const state = cronState(session);
  return { jobs: [...state.jobs.values()].map((job) => ({ id: job.id, cron: job.cron, prompt: job.prompt, recurring: job.recurring, next_run: job.nextRun ? job.nextRun.toISOString() : null, runs: job.runs })) };
}

export function deleteCronJob(session, id) {
  const state = cronState(session);
  const removed = state.jobs.delete(String(id || ''));
  if (!state.jobs.size) stopCron(session);
  return { deleted: removed, id };
}

// Fire due jobs. Exported for tests; the timer calls it every 15 seconds.
export function tickCron(session, date = new Date()) {
  const state = cronState(session);
  const fired = [];
  for (const job of [...state.jobs.values()]) {
    if (!job.nextRun || job.nextRun.getTime() > date.getTime()) continue;
    job.runs += 1;
    fired.push(job);
    if (job.recurring) job.nextRun = nextCronRun(job.fields, date);
    else state.jobs.delete(job.id);
  }
  for (const job of fired) {
    if (typeof state.onFire === 'function') { try { state.onFire(job.prompt, job); } catch {} }
    else (state.pending ||= []).push(job.prompt);
  }
  if (!state.jobs.size) stopCron(session);
  return fired;
}

function ensureCronTimer(session) {
  const state = cronState(session);
  if (state.timer) return;
  state.timer = setInterval(() => tickCron(session), 15000);
  if (state.timer.unref) state.timer.unref();
}

export function stopCron(session) {
  const state = session && session.cron;
  if (state && state.timer) { clearInterval(state.timer); state.timer = null; }
}

export async function runSessionTool(session, name, args, options = {}) {
  switch (name) {
    case 'tool_search': return searchTools(session, args);
    case 'terminal_read': {
      if (!session.ptyManager) throw new Error('No PTY terminal sessions have been started in this OASIS session. Use run_command with interactive=true first.');
      return await session.ptyManager.read(args.id, { offset: args.offset, maxChars: args.max_chars, waitMs: Math.max(0, Math.min(30, Number(args.wait_seconds) || 0)) * 1000 });
    }
    case 'terminal_list': return session.ptyManager ? session.ptyManager.list() : { sessions: [] };
    case 'terminal_input': {
      if (!session.ptyManager) throw new Error('No PTY terminal sessions have been started in this OASIS session.');
      return session.ptyManager.write(args.id, args.data);
    }
    case 'terminal_resize': {
      if (!session.ptyManager) throw new Error('No PTY terminal sessions have been started in this OASIS session.');
      return session.ptyManager.resize(args.id, args.cols, args.rows);
    }
    case 'terminal_interrupt': {
      if (!session.ptyManager) throw new Error('No PTY terminal sessions have been started in this OASIS session.');
      return session.ptyManager.interrupt(args.id);
    }
    case 'terminal_stop': {
      if (!session.ptyManager) throw new Error('No PTY terminal sessions have been started in this OASIS session.');
      return session.ptyManager.stop(args.id);
    }
    case 'monitor_command': return monitorCommand(session, args, options);
    case 'enter_plan_mode': return enterPlanMode(session, args);
    case 'enter_worktree': return enterWorktree(session, args, options);
    case 'exit_worktree': return exitWorktree(session, args, options);
    case 'notify': return notifyUser(args, options.notify || {});
    case 'cron_create': return createCronJob(session, args);
    case 'cron_list': return listCronJobs(session);
    case 'cron_delete': return deleteCronJob(session, args.id);
    default:
      if (SHARED_TASK_TOOL_NAMES.has(name)) return runSharedTaskTool(session, name, args);
      throw new Error('Unknown session tool ' + name);
  }
}

// EnterWorktree / ExitWorktree (Claude Code): move the whole session into a worktree and back.
async function gitOut(cwd, args) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));
}

async function enterWorktree(session, args = {}, options = {}) {
  const path = (await import('node:path')).default;
  const { createWorktree, WORKTREE_DIR } = await import('./worktrees.mjs');
  if (args.path) {
    const base = session.worktreeSession ? session.worktreeSession.originalRoot : session.root;
    const target = path.resolve(session.root, String(args.path));
    const common = async (dir) => path.resolve(dir, await gitOut(dir, ['rev-parse', '--git-common-dir']));
    const [mine, theirs] = await Promise.all([common(base), common(target).catch(() => null)]);
    if (!theirs || theirs !== mine) throw new Error(target + ' is not a worktree of this repository.');
    const managed = [WORKTREE_DIR, path.join('.claude', 'worktrees')].some((dir) => target.startsWith(path.join(base, dir) + path.sep));
    if (session.worktreeSession && !managed) throw new Error('From inside a worktree you can only switch to worktrees under ' + WORKTREE_DIR + '.');
    if (!managed) {
      const approve = typeof options.approval === 'function' ? options.approval : null;
      const ok = approve ? await approve('Move this session (and its write access) into the worktree ' + target + '?', true) : false;
      if (!ok) throw new Error('Entering ' + target + ' needs your approval (it is outside ' + WORKTREE_DIR + ').');
    }
    if (!session.worktreeSession) session.worktreeSession = { originalRoot: session.root, created: null };
    session.worktreeSession.current = target;
    session.root = target;
    return { entered: target, created: false, message: 'Working directory is now ' + target + '. Files, commands and git act there until exit_worktree.' };
  }
  if (session.worktreeSession) throw new Error('Already in a worktree (' + session.root + '). Call exit_worktree first, or pass path to switch to another managed worktree.');
  const { hookOptions } = options;
  const worktree = await createWorktree(session.root, String(args.name || 'session'), { env: options.env, hookOptions });
  session.worktreeSession = { originalRoot: session.root, created: worktree, current: worktree.path };
  session.root = worktree.path;
  return { entered: worktree.path, created: true, branch: worktree.branch || null, message: 'Created ' + (worktree.relative || worktree.path) + (worktree.branch ? ' on branch ' + worktree.branch : '') + ' and switched into it. Files, commands and git act there until exit_worktree.' };
}

async function exitWorktree(session, args = {}, options = {}) {
  const state = session.worktreeSession;
  if (!state) throw new Error('This session is not in a worktree entered with enter_worktree.');
  const action = String(args.action || 'keep');
  const worktree = state.created;
  let note = '';
  if (action === 'remove') {
    if (!worktree || worktree.hook) throw new Error('Only a worktree created by enter_worktree in this session can be removed here; use action "keep".');
    const status = await gitOut(worktree.path, ['status', '--porcelain', '--untracked-files=all']).catch(() => '');
    const head = await gitOut(worktree.path, ['rev-parse', 'HEAD']).catch(() => worktree.base);
    if ((status || head !== worktree.base) && args.discard_changes !== true) {
      throw new Error('The worktree has ' + (status ? status.split('\n').length + ' uncommitted change(s)' : '') + (status && head !== worktree.base ? ' and ' : '') + (head !== worktree.base ? 'new commits on ' + worktree.branch : '') + '. Use action "keep", or pass discard_changes: true after confirming with the user.');
    }
    const { removeWorktree } = await import('./worktrees.mjs');
    await removeWorktree(state.originalRoot, worktree, { env: options.env, deleteBranch: true });
    note = 'Removed ' + worktree.path + ' and branch ' + worktree.branch + '.';
  } else {
    note = 'Kept ' + state.current + (worktree && worktree.branch ? ' (branch ' + worktree.branch + '; merge with git merge ' + worktree.branch + ')' : '') + '.';
  }
  session.root = state.originalRoot;
  session.worktreeSession = null;
  return { returned_to: session.root, message: note + ' Working directory is back to ' + session.root + '.' };
}
