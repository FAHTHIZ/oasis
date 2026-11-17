// Conversation timeline: how agent activity reads in the app.
//
// The app shows a task the way a person would narrate it: short prose
// updates from the agent, with the work in between folded into execution
// groups ("Edited math.mjs, ran the tests · 4 steps · 12s"). Each step in a
// group can be opened to inspect its exact input and output. Everything here
// is pure (no DOM), so it is shared by the live view and by restored chats,
// and it is unit tested in Node.

import { commandIntent, commandActivityLabel } from './command-intent.mjs';

const SHELL = new Set(['run_command', 'run_shell', 'powershell', 'auto_test', 'bash', 'shell', 'command_output', 'kill_command', 'list_background']);
const READ = new Set(['read_file', 'read_notebook', 'notebook_read', 'list_files', 'list_directory', 'view_image']);
const EDIT = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'apply_patch', 'delete_file', 'move_file', 'rename_file']);
const SEARCH = new Set(['grep', 'search_files', 'glob_files', 'repo_map', 'lsp', 'diagnostics', 'ide_get_diagnostics', 'find_symbol']);
const WEB = new Set(['web_search', 'fetch_url', 'browser']);
const GIT = new Set(['git_diff', 'git_status', 'git_log', 'git_branch', 'git_commit', 'git_push', 'create_pull_request', 'github_push', 'worktree_inspect', 'worktree_merge']);
const AGENT = new Set(['task', 'agent_status', 'send_message', 'agent_stop', 'advisor', 'run_specialist_review']);
const PLAN = new Set(['todo_write', 'exit_plan_mode', 'ask_user_question', 'connect_service', 'load_skill', 'read_skill_resource', 'list_skills']);

// One word for the kind of work a tool does; drives the step icon.
export function toolKind(name) {
  const n = String(name || '').toLowerCase();
  if (SHELL.has(n)) return 'shell';
  if (READ.has(n)) return 'read';
  if (EDIT.has(n)) return 'edit';
  if (SEARCH.has(n)) return 'search';
  if (WEB.has(n)) return 'web';
  if (GIT.has(n)) return 'git';
  if (AGENT.has(n)) return 'agent';
  if (PLAN.has(n)) return 'plan';
  return 'tool';
}

function baseName(args = {}) {
  return String(args.path || args.file_path || args.notebook_path || '').replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).at(-1) || '';
}
function commandOf(args = {}) {
  return [args.command, ...(Array.isArray(args.args) ? args.args : [])].filter((part) => part !== undefined && part !== null && part !== '').join(' ');
}
function isTestCommand(command) {
  const parts = String(command).toLowerCase().split(/[ \t]+/).filter(Boolean);
  const runner = ['npm', 'pnpm', 'yarn', 'bun', 'npx'].includes(parts[0]) && parts.some((part) => ['test', 'check', 'vitest', 'jest', 'playwright', 'mocha'].includes(part));
  return runner || (parts[0] === 'node' && parts.includes('--test')) || parts[0] === 'pytest' || (parts[0] === 'go' && parts[1] === 'test') || (parts[0] === 'cargo' && parts[1] === 'test');
}
function words(value) { return String(value).replace(/[_-]+/g, ' ').trim(); }

// A short hint shown next to the label: the file, pattern, command or URL.
export function summarizeArgs(name, args = {}) {
  if (!args || typeof args !== 'object') return '';
  if (args.pattern) return args.pattern + (args.path ? '  in ' + args.path : '');
  // The project root ("." or "./") says nothing next to "Listed project files".
  if (args.path || args.file_path) return /^\.\/?$/.test(String(args.path || args.file_path)) ? '' : String(args.path || args.file_path) + (args.offset ? ':' + args.offset : '');
  if (args.url) return String(args.url);
  if (name === 'task' && args.description) return String(args.description).slice(0, 100);
  if (args.name) return String(args.name);
  if (args.code) return String(args.code).split('\n')[0].slice(0, 80);
  if (args.command) return commandOf(args).slice(0, 100);
  if (args.query) return String(args.query).slice(0, 80);
  if (args.summary) return String(args.summary).slice(0, 100);
  if (args.branch) return String(args.branch);
  if (Array.isArray(args.todos)) return args.todos.length + ' items';
  return '';
}

const EXTRA_LABELS = {
  browser: 'Used the browser', command_output: 'Checked a running command', kill_command: 'Stopped a running command',
  list_background: 'Checked background tasks', git_branch: 'Managed branches', git_commit: 'Made a commit', git_push: 'Pushed the branch',
  create_pull_request: 'Opened a pull request', worktree_inspect: 'Checked the review copy', worktree_merge: 'Merged the review copy',
  advisor: 'Asked the advisor model', run_specialist_review: 'Ran a specialist review', install_extension: 'Installed an extension',
  add_extension: 'Added an extension', install_external_skill: 'Installed a skill', install_plugin: 'Installed a plugin', plugins: 'Checked plugins',
  configure_mcp_server: 'Set up a tool server', configure_provider: 'Set up a model provider', mcp: 'Checked tool servers',
  list_directory: 'Listed a folder', read_notebook: 'Read a notebook', notebook_read: 'Read a notebook', github_push: 'Pushed to GitHub'
};

// Unknown tools still say what ran: 'mcp__context7__resolve-library-id' → 'Used context7: resolve library id'.
export function fallbackToolLabel(name) {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(name || ''));
  if (mcp) return 'Used ' + words(mcp[1]) + ': ' + words(mcp[2]);
  if (String(name || '').startsWith('mcp_')) return 'Used a connected tool: ' + words(String(name).slice(4));
  return name ? 'Used ' + words(name) : 'Completed a project step';
}

// Past tense, for finished steps: "Edited math.mjs", "Ran the tests".
export function activityLabel(tool = {}) {
  const name = String(tool.name || '').toLowerCase();
  const args = tool.args || {};
  const file = baseName(args);
  if (['run_command', 'run_shell', 'powershell', 'auto_test', 'bash', 'shell'].includes(name)) {
    const command = commandOf(args);
    if (isTestCommand(command)) return 'Ran the tests';
    return commandActivityLabel(commandIntent(command)) || 'Ran a command';
  }
  if (name === 'read_file') return file ? 'Read ' + file : 'Read a file';
  if (name === 'list_files') return 'Listed project files';
  if (name === 'write_file') return file ? 'Wrote ' + file : 'Wrote a file';
  if (['edit_file', 'multi_edit', 'notebook_edit', 'apply_patch'].includes(name)) return file ? 'Edited ' + file : 'Edited files';
  if (name === 'delete_file') return file ? 'Deleted ' + file : 'Deleted a file';
  if (['grep', 'search_files', 'glob_files', 'repo_map'].includes(name)) return 'Searched the project';
  if (name === 'web_search') return 'Searched the web';
  if (name === 'fetch_url') return 'Read a web page';
  if (name === 'git_diff') return 'Reviewed the diff';
  if (name === 'git_status') return 'Checked project changes';
  if (name === 'git_log') return 'Reviewed recent project history';
  if (name === 'todo_write') return 'Updated the task plan';
  if (name === 'load_skill' || name === 'read_skill_resource' || name === 'list_skills') return 'Used a skill';
  if (name === 'task') {
    const type = String(args.subagent_type || '').slice(0, 40);
    return (args.run_in_background ? 'Started ' : 'Ran ') + (type && type !== 'general-purpose' ? 'the ' + type + ' agent' : 'a subagent');
  }
  if (name === 'agent_status') return 'Checked on subagents';
  if (name === 'send_message') return 'Sent a message to a subagent';
  if (name === 'agent_stop') return 'Stopped a subagent';
  if (name === 'ask_user_question') return 'Asked you a question';
  if (name === 'connect_service') return 'Connected ' + (String(args.service || '').slice(0, 40) || 'a service');
  if (name === 'exit_plan_mode') return 'Presented a plan';
  if (name === 'lsp' || name === 'diagnostics' || name === 'ide_get_diagnostics') return 'Checked for code issues';
  if (EXTRA_LABELS[name]) return EXTRA_LABELS[name];
  if (args._label && !String(args._label).startsWith('Used ')) return String(args._label);
  return fallbackToolLabel(name);
}

// Present tense, for the step that is running right now: "Editing math.mjs".
export function liveLabel(tool = {}) {
  const name = String(tool.name || '').toLowerCase();
  const args = tool.args || {};
  const file = baseName(args);
  if (['run_command', 'run_shell', 'powershell', 'auto_test', 'bash', 'shell'].includes(name)) {
    const command = commandOf(args);
    if (isTestCommand(command)) return 'Running the tests';
    const looking = commandActivityLabel(commandIntent(command), { live: true });
    if (looking) return looking;
    return command ? 'Running ' + (command.length > 60 ? command.slice(0, 57) + '…' : command) : 'Running a command';
  }
  if (name === 'read_file') return file ? 'Reading ' + file : 'Reading a file';
  if (name === 'list_files' || name === 'list_directory') return 'Looking through the project';
  if (name === 'write_file') return file ? 'Writing ' + file : 'Writing a file';
  if (['edit_file', 'multi_edit', 'notebook_edit', 'apply_patch'].includes(name)) return file ? 'Editing ' + file : 'Editing files';
  if (name === 'delete_file') return file ? 'Deleting ' + file : 'Deleting a file';
  if (['grep', 'search_files', 'glob_files', 'repo_map'].includes(name)) return args.pattern ? 'Searching for ' + String(args.pattern).slice(0, 40) : 'Searching the project';
  if (name === 'web_search') return args.query ? 'Searching the web for ' + String(args.query).slice(0, 50) : 'Searching the web';
  if (name === 'fetch_url') return 'Reading a web page';
  if (name === 'git_diff') return 'Reviewing the diff';
  if (name === 'git_status') return 'Checking project changes';
  if (name === 'git_commit') return 'Making a commit';
  if (name === 'todo_write') return 'Updating the plan';
  if (name === 'task') return args.description ? 'Delegating: ' + String(args.description).slice(0, 60) : 'Starting a subagent';
  if (name === 'ask_user_question') return 'Waiting for your answer';
  if (name === 'connect_service') return 'Waiting for you to connect ' + (String(args.service || '').slice(0, 40) || 'a service');
  if (name === 'lsp' || name === 'diagnostics' || name === 'ide_get_diagnostics') return 'Checking for code issues';
  if (name === 'browser') return 'Using the browser';
  const done = activityLabel(tool);
  return done.replace(/^Used /, 'Using ').replace(/^Ran /, 'Running ').replace(/^Checked /, 'Checking ');
}

const KIND_PHRASES = {
  read: (n) => n === 1 ? 'read a file' : 'read ' + n + ' files',
  edit: (n) => n === 1 ? 'edited a file' : 'edited ' + n + ' files',
  shell: (n) => n === 1 ? 'ran a command' : 'ran ' + n + ' commands',
  search: (n) => n === 1 ? 'searched the project' : 'searched ' + n + ' times',
  web: (n) => n === 1 ? 'checked the web' : 'checked ' + n + ' web sources',
  git: (n) => n === 1 ? 'checked git' : 'used git ' + n + ' times',
  agent: (n) => n === 1 ? 'used a subagent' : 'used ' + n + ' subagents',
  plan: (n) => n === 1 ? 'updated the plan' : 'updated the plan ' + n + ' times',
  tool: (n) => n === 1 ? 'used a tool' : 'used ' + n + ' tools'
};

function sentence(text) { return text ? text[0].toUpperCase() + text.slice(1) : text; }

// What happened to a step, honestly: 'running', 'ok', 'failed',
// 'declined' (you said no), 'blocked' (a rule stopped it), 'cancelled'
// (the task was stopped first) or 'timed_out'. Older saved steps only
// have ok: true/false.
const OUTCOMES = new Set(['ok', 'failed', 'declined', 'blocked', 'cancelled', 'timed_out']);
export function stepOutcome(step = {}) {
  if (step.ok === undefined) return 'running';
  if (OUTCOMES.has(step.outcome)) return step.outcome;
  return step.ok ? 'ok' : 'failed';
}
// Steps that never ran: a summary must not say they did.
const NOT_RUN = new Set(['declined', 'blocked', 'cancelled']);
export function stepRan(step) { return !NOT_RUN.has(stepOutcome(step)); }
const NOT_RUN_LABELS = { declined: 'You declined', blocked: 'Blocked', cancelled: 'Stopped before it ran' };
function movedToBackground(step) {
  const content = String(step.content || '');
  return content.startsWith('{"') && content.slice(0, content.indexOf('\n') === -1 ? content.length : content.indexOf('\n')).includes('"movedToBackground":true');
}
// The label of one step, in the tense and outcome it actually had.
export function stepLabel(step = {}) {
  const outcome = stepOutcome(step);
  if (outcome === 'running') return liveLabel(step);
  if (NOT_RUN.has(outcome)) {
    const what = summarizeArgs(step.name, step.args) || liveLabel(step).replace(/^\w+ing /, '').trim() || 'this step';
    return NOT_RUN_LABELS[outcome] + ': ' + (what.length > 70 ? what.slice(0, 67) + '…' : what);
  }
  if (outcome === 'ok' && movedToBackground(step)) {
    const what = summarizeArgs(step.name, step.args) || 'a command';
    return 'Moved to the background: ' + (what.length > 70 ? what.slice(0, 67) + '…' : what);
  }
  const done = step.label && !/^Used /.test(step.label) ? step.label : activityLabel(step);
  return outcome === 'failed' || outcome === 'timed_out' ? failedLabel(done, outcome) : done;
}

// "Wrote notes.txt" that failed reads "Couldn't write notes.txt"; a failed
// test run reads "Tests failed". Labels without a known verb keep their words.
const FAILED_VERBS = { Wrote: 'write', Edited: 'edit', Read: 'read', Deleted: 'delete', Searched: 'search', Listed: 'list', Updated: 'update', Made: 'make', Pushed: 'push', Opened: 'open', Installed: 'install', Added: 'add', Connected: 'connect', Checked: 'check', Reviewed: 'review', Merged: 'merge', Asked: 'ask', Started: 'start', Stopped: 'stop', Sent: 'send', Managed: 'manage', Presented: 'present' };
function failedLabel(label, outcome) {
  const failed = outcome === 'timed_out' ? 'timed out' : 'failed';
  if (label === 'Ran the tests') return 'Tests ' + failed;
  if (label === 'Ran a command') return 'Command ' + failed;
  const phrase = failingPhrase(label);
  return outcome === 'timed_out' ? phrase.replace(/^Couldn't /, 'Timed out trying to ') : phrase;
}
function failingPhrase(label) {
  const match = /^(\w+) (.*)$/.exec(label);
  if (match && FAILED_VERBS[match[1]]) return "Couldn't " + FAILED_VERBS[match[1]] + ' ' + match[2];
  if (match && match[1] === 'Ran') return "Couldn't run " + match[2];
  if (match && match[1] === 'Used') return "Couldn't use " + match[2];
  return label;
}

// One line for a finished group: one step is named exactly ("Edited
// math.mjs"); more steps are summed up by kind ("Read 2 files, edited a
// file and ran the tests"), at most three kinds and then "and N more".
// Steps that did not run (declined, blocked, stopped) are never counted as
// work done; groupStats counts them for the header instead.
// The kind of work for a group title: a shell command that only reads or
// searches counts with the reads and searches ("Read 3 files", not "Ran 3
// commands"); the tests are their own kind.
function shellIntent(step) {
  if (toolKind(step.name) !== 'shell' || !SHELL_RUNS.has(String(step.name || '').toLowerCase())) return null;
  return commandIntent(commandOf(step.args || {}));
}
const SHELL_RUNS = new Set(['run_command', 'run_shell', 'powershell', 'auto_test', 'bash', 'shell']);
function stepWorkKind(step) {
  const kind = toolKind(step.name);
  if (kind !== 'shell') return kind;
  if (isTestCommand(commandOf(step.args || {}))) return 'tests';
  const intent = shellIntent(step);
  if (intent && intent.kind === 'read') return 'read';
  if (intent && (intent.kind === 'search' || intent.kind === 'list')) return 'search';
  return 'shell';
}
function stepFiles(step) {
  const intent = shellIntent(step);
  if (intent && intent.kind === 'read' && intent.targets.length) return intent.targets.map((target) => target.replace(/^\.\//, ''));
  return [baseName(step.args) || step.id];
}

// A task-plan update. The plan card over the message box already shows the
// plan as it moves, so in the feed these steps stay out of sight (and out of
// group titles and counts) unless one failed; the Activity panel lists them.
export function isPlanStep(step = {}) {
  return String(step.name || '') === 'todo_write' && step.ok !== false;
}
// The steps a group shows: all but plan updates, or the plan updates when
// that is all the group did.
export function feedSteps(steps = []) {
  const shown = steps.filter((step) => !isPlanStep(step));
  return shown.length ? shown : steps;
}

export function groupTitle(all = []) {
  const steps = feedSteps(all);
  if (!steps.length) return 'Working';
  const running = steps.find((step) => step.ok === undefined);
  if (running) return liveLabel(running);
  const ran = steps.filter(stepRan);
  if (!ran.length) return steps.length === 1 ? stepLabel(steps[0]) : 'Nothing ran: ' + notRunPhrase(steps);
  if (ran.length === 1) return stepLabel(ran[0]);
  // Kinds in the order the work happened; a kind done once is named exactly.
  const byKind = new Map();
  for (const step of ran) {
    const kind = stepWorkKind(step);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(step);
  }
  const lower = (text) => text ? text[0].toLowerCase() + text.slice(1) : text;
  const parts = [];
  for (const [kind, list] of byKind) {
    if (kind === 'tests') { parts.push(list.length === 1 ? 'ran the tests' : 'ran the tests ' + list.length + ' times'); continue; }
    // Files touched: count distinct paths, so three edits to one file read as one.
    const distinct = (steps) => kind === 'read' || kind === 'edit' ? new Set(steps.flatMap((step) => stepFiles(step))).size : steps.length;
    // Only work that worked is claimed; a kind where every step failed says so
    // ("couldn't edit 2 files"), never "edited 2 files" under a red cross.
    const worked = list.filter((step) => step.ok !== false);
    if (!worked.length) {
      const n = distinct(list);
      parts.push(n === 1 ? lower(stepLabel(list[0])) : lower(failingPhrase(sentence(KIND_PHRASES[kind](n)))));
      continue;
    }
    const n = distinct(worked);
    // Two files are named, not counted ("read a.mjs and b.mjs"): a count
    // hides exactly what people look for in folded work.
    const fileTools = ['read_file', 'edit_file', 'multi_edit', 'write_file', 'notebook_edit', 'apply_patch'];
    const names = n === 2 && (kind === 'read' || kind === 'edit') && worked.every((step) => fileTools.includes(step.name)) ? [...new Set(worked.flatMap((step) => stepFiles(step)))].filter((name) => !worked.some((step) => step.id === name)) : [];
    if (names.length === 2) { parts.push((kind === 'read' ? 'read ' : 'edited ') + names[0] + ' and ' + names[1]); continue; }
    parts.push(n === 1 ? lower(activityLabel(worked[0])) : KIND_PHRASES[kind](n));
  }
  // "and 1 more" hides less than it costs: a fourth kind is named outright.
  const shown = parts.length > 4 ? parts.slice(0, 3).concat(parts.length - 3 + ' more') : parts;
  const list = shown.length > 1 ? shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1) : shown[0];
  return sentence(list);
}
function notRunPhrase(steps) {
  const counts = groupStats(steps);
  return [counts.declined && counts.declined + ' declined', counts.blocked && counts.blocked + ' blocked', counts.stopped && counts.stopped + ' stopped'].filter(Boolean).join(', ');
}

export function groupStats(all = []) {
  const steps = feedSteps(all);
  const outcomes = steps.map(stepOutcome);
  const count = (...kinds) => outcomes.filter((outcome) => kinds.includes(outcome)).length;
  const running = count('running');
  const starts = steps.map((step) => Number(step.startedAt)).filter(Number.isFinite);
  const ends = steps.map((step) => Number(step.endedAt)).filter(Number.isFinite);
  const timing = !running && starts.length && ends.length ? groupTiming(steps) : null;
  const durationMs = timing ? timing.spanMs : null;
  return { total: steps.length, failed: count('failed', 'timed_out'), declined: count('declined'), blocked: count('blocked'), stopped: count('cancelled'), running, durationMs };
}

// One definition of time for the transcript, all on the server's clock:
//   header  = run start to now (or to the run's end)
//   group   = first step start to last step end (to now while a step runs)
//   tools   = time when at least one step of the group was running
//   thinking = the rest of the group's span: the model working between steps
// Steps that started but never ended count to `now`. Returns null for a
// group with no timed steps.
export function groupTiming(steps = [], now = Date.now()) {
  const spans = [];
  for (const step of steps) {
    const start = Number(step && step.startedAt);
    if (!Number.isFinite(start) || start <= 0) continue;
    let end = Number(step.endedAt);
    if (!Number.isFinite(end) && Number.isFinite(Number(step.durationMs))) end = start + Number(step.durationMs);
    if (!Number.isFinite(end)) end = step.ok === undefined ? now : start;
    spans.push([start, Math.max(start, end)]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let toolMs = 0;
  let [from, to] = spans[0];
  for (const [start, end] of spans.slice(1)) {
    if (start > to) { toolMs += to - from; from = start; to = end; } else to = Math.max(to, end);
  }
  toolMs += to - from;
  const spanMs = Math.max(...spans.map((span) => span[1])) - spans[0][0];
  return { startedAt: spans[0][0], endedAt: spans[0][0] + spanMs, spanMs, toolMs, thinkingMs: Math.max(0, spanMs - toolMs) };
}

// The header's elapsed time: run start to now (or to the end once finished).
export function runElapsed(startedAt, now = Date.now()) {
  const start = Number(startedAt);
  return Number.isFinite(start) && start > 0 ? Math.max(0, Number(now) - start) : 0;
}

// The split shown inside an expanded group: "tools 2s · thinking 43s".
export function timingSplit(timing) {
  if (!timing || !(timing.spanMs > 0)) return '';
  return 'tools ' + (formatDuration(timing.toolMs) || '<0.1s') + ' · thinking ' + (formatDuration(timing.thinkingMs) || '<0.1s');
}

// The waiting chip: it counts how long the model has been working, so a slow
// provider or a local model loading into memory never looks frozen.
export function thinkingLabel(elapsedMs) {
  const value = Number(elapsedMs);
  return Number.isFinite(value) && value >= 1000 ? 'Thinking · ' + formatDuration(value) : 'Thinking';
}

// The settled reasoning block: "Thought for 12s" ("Thought" when the time is unknown).
export function thoughtLabel(elapsedMs) {
  const value = Number(elapsedMs);
  return Number.isFinite(value) && value >= 1000 ? 'Thought for ' + formatDuration(value) : 'Thought';
}

// The headline of a settled thought, as Claude and Perplexity show it: the
// summary's own bold title when it has one ("**Finding the bug**"), else its
// first sentence, plain text, at most about one line. '' when there is none.
export function thoughtHeadline(text, max = 96) {
  const source = String(text || '').trim();
  if (!source) return '';
  const bold = source.match(/^\s*(?:#{1,6}\s*)?\*\*([^*\n]{3,120})\*\*\s*(?:\n|$)/);
  let line = bold ? bold[1] : source
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .split(/\n/).find((row) => row.trim()) || '';
  line = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    .replace(/^\s*(?:[-+>]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!bold) {
    // The first sentence; a period inside a name (dates.mjs, e.g.) does not end it.
    const end = line.search(/[.!?](?=\s+[A-Z("'`]|$)/);
    if (end > 0) line = line.slice(0, end + (line[end] === '.' ? 0 : 1));
  }
  line = line.replace(/[:;,]$/, '').trim();
  if (/^[a-z]/.test(line)) line = line[0].toUpperCase() + line.slice(1);
  if (line.length > max) line = line.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return line;
}

// Small local models often write a tool call as JSON text instead of a native call,
// sometimes after a sentence of prose. OASIS turns it into a real call when the reply
// ends; while it streams, show the prose and which tool is being prepared instead of a
// wall of escaped JSON. Returns { text, tool }: the prose before the call, and the
// tool name ('' when the text holds no call).
const TEXT_TOOL_CALL = /(?:```(?:json)?\s*)?(?:<tool_call>\s*)?\[?\s*\{\s*"(?:name|tool)"\s*:\s*"([A-Za-z_][\w.-]{0,63})"\s*,\s*"(?:arguments|parameters|args|input)"\s*:/;
export function splitTextToolCall(text) {
  const value = String(text || '');
  const match = TEXT_TOOL_CALL.exec(value);
  // A JSON value that is the whole answer (asked for by the user) has no prose before it
  // and no tool-call shape; only the name-plus-arguments shape counts.
  if (!match) return { text: value, tool: '' };
  return { text: value.slice(0, match.index).trimEnd(), tool: match[1] };
}

export function formatDuration(ms) {
  // Unknown (a step reopened from a saved session) shows nothing, not "<0.1s".
  if (ms === null || ms === undefined || ms === '') return '';
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return value < 50 ? '<0.1s' : (value / 1000).toFixed(1) + 's';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  // Past an hour the clock reads "1h 02m 05s", not "62m 05s".
  if (minutes >= 60) return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
  return minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
}

const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|credential)/i;

// What went into a step, as labelled sections the inspector can render:
// a command, a diff, a file body, or the raw arguments.
export function describeInput(tool = {}) {
  const name = String(tool.name || '').toLowerCase();
  const args = tool.args && typeof tool.args === 'object' ? tool.args : {};
  const sections = [];
  const kind = toolKind(name);
  if (kind === 'shell' && (args.command || args.args)) {
    sections.push({ label: 'Command', format: 'command', text: commandOf(args) });
    if (args.cwd) sections.push({ label: 'Folder', format: 'text', text: String(args.cwd) });
  } else if (name === 'edit_file' && (args.old_string !== undefined || args.new_string !== undefined)) {
    sections.push({ label: 'File', format: 'path', text: String(args.path || args.file_path || '') });
    sections.push({ label: 'Change', format: 'diff', old: String(args.old_string ?? ''), new: String(args.new_string ?? '') });
  } else if (name === 'multi_edit' && Array.isArray(args.edits)) {
    sections.push({ label: 'File', format: 'path', text: String(args.path || args.file_path || '') });
    args.edits.slice(0, 20).forEach((edit, index) => sections.push({ label: 'Change ' + (index + 1), format: 'diff', old: String(edit && edit.old_string || ''), new: String(edit && edit.new_string || '') }));
  } else if (name === 'write_file' && typeof args.content === 'string') {
    sections.push({ label: 'File', format: 'path', text: String(args.path || args.file_path || '') });
    sections.push({ label: 'Content', format: 'code', text: args.content });
  } else if (name === 'todo_write' && Array.isArray(args.todos)) {
    // The plan as a checklist, not the JSON the model sent.
    sections.push({ label: 'Plan', format: 'checklist', items: args.todos.filter((todo) => todo && typeof todo === 'object').map((todo) => ({ text: String(todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content || ''), status: ['completed', 'in_progress'].includes(todo.status) ? todo.status : 'pending' })) });
  } else if ((name === 'read_file' || name === 'read_notebook' || name === 'notebook_read' || name === 'view_image') && (args.path || args.file_path || args.notebook_path)) {
    sections.push({ label: 'File', format: 'path', text: String(args.path || args.file_path || args.notebook_path) });
    const from = Number(args.offset ?? args.start_line);
    const count = Number(args.limit ?? (Number.isFinite(Number(args.end_line)) && Number.isFinite(from) ? Number(args.end_line) - from + 1 : NaN));
    if (Number.isFinite(from) && from > 0) sections.push({ label: 'Lines', format: 'text', text: Number.isFinite(count) && count > 0 ? from + '–' + (from + count - 1) : 'from ' + from });
  } else if ((name === 'grep' || name === 'search_files' || name === 'glob_files') && (args.pattern || args.query || args.glob)) {
    sections.push({ label: name === 'glob_files' ? 'Files matching' : 'Search for', format: 'path', text: String(args.pattern || args.query || args.glob) });
    if (args.path && args.path !== '.') sections.push({ label: 'In', format: 'path', text: String(args.path) });
    if (args.include || args.glob && args.pattern) sections.push({ label: 'Only', format: 'path', text: String(args.include || args.glob) });
  } else if ((name === 'list_files' || name === 'list_directory') && Object.keys(args).every((key) => key.startsWith('_') || ['path', 'depth', 'recursive'].includes(key))) {
    sections.push({ label: 'Folder', format: 'path', text: !args.path || args.path === '.' ? 'Project folder' : String(args.path) });
  } else if (name === 'task') {
    if (args.description) sections.push({ label: 'Task', format: 'text', text: String(args.description) });
    if (args.subagent_type) sections.push({ label: 'Agent', format: 'text', text: String(args.subagent_type) });
    if (args.prompt) sections.push({ label: 'Instructions', format: 'prose', text: String(args.prompt) });
  } else {
    const shown = {};
    for (const [key, value] of Object.entries(args)) {
      if (key.startsWith('_')) continue;
      shown[key] = SECRET_KEY.test(key) ? '[hidden]' : value;
    }
    if (Object.keys(shown).length) sections.push({ label: 'Input', format: 'json', text: JSON.stringify(shown, null, 2) });
  }
  return sections;
}

// Groups the display entries of a conversation into what the transcript
// shows: user messages, prose and execution groups. A model step that only
// ran tools joins the group before it, so a run of tool calls reads as one
// block until the agent says something.
export function buildTimeline(entries = []) {
  const blocks = [];
  let group = null;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.role !== 'assistant') {
      group = null;
      blocks.push({ type: entry.role || 'note', entry });
      continue;
    }
    // What the model said while reasoning before this step (a provider
    // summary) sits between the work before and after it.
    if (entry.reasoning && String(entry.reasoning.text || '').trim()) {
      group = null;
      blocks.push({ type: 'reasoning', entry });
    }
    const text = String(entry.content || '').trim();
    if (text) {
      group = null;
      blocks.push({ type: 'text', entry });
    }
    const tools = Array.isArray(entry.tools) ? entry.tools : [];
    if (tools.length || (entry.subagents && entry.subagents.length)) {
      if (!group) { group = { type: 'group', steps: [], subagents: [], entries: [] }; blocks.push(group); }
      group.steps.push(...tools);
      group.entries.push(entry);
      if (entry.subagents && entry.subagents.length) group.subagents = entry.subagents;
    }
  }
  return blocks;
}

// Short label for the timer on a live group: "12s", "1m 05s".
export function elapsedSince(start, now = Date.now()) {
  return Number.isFinite(Number(start)) ? formatDuration(now - Number(start)) : '';
}

// What a step returned, readable: a failed tool's {"error":"…"} shows the
// sentence once (OASIS adds "This step failed: …" below it), and a command
// result {command, exitCode, stdout, stderr, …} shows its output, not JSON.
export function readableOutput(content) {
  const text = String(content || '');
  const newline = text.indexOf('\n');
  const first = newline === -1 ? text : text.slice(0, newline);
  if (!first.startsWith('{"')) return text;
  let value;
  try { value = JSON.parse(first); } catch { return text; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return text;
  const rest = newline === -1 ? '' : text.slice(newline + 1).trim();
  if (typeof value.error === 'string' && Object.keys(value).length === 1) {
    const error = value.error;
    if (!error) return text;
    return rest && rest.includes(error.slice(0, 60)) ? rest : (error + (rest ? '\n' + rest : ''));
  }
  // A file read: its text, not the JSON envelope around it.
  if (typeof value.content === 'string' && typeof value.path === 'string' && Object.keys(value).every((key) => ['path', 'content', 'truncated', 'lines', 'totalLines', 'startLine', 'endLine', 'note', 'offset', 'limit', 'size', 'encoding'].includes(key))) {
    return value.content + (value.truncated ? '\n… (cut short)' : '') + (rest ? '\n' + rest : '');
  }
  // Search matches: one "path:line  text" row each, as grep prints them.
  if (Array.isArray(value.matches) && value.matches.every((match) => match && typeof match === 'object' && typeof match.path === 'string')) {
    if (!value.matches.length) return 'No matches.' + (rest ? '\n' + rest : '');
    return value.matches.map((match) => match.path + (match.line ? ':' + match.line : '') + (match.text !== undefined ? '  ' + String(match.text).trim() : '')).join('\n') + (value.truncated ? '\n… more matches not shown' : '') + (rest ? '\n' + rest : '');
  }
  // An edit: what changed, in a sentence, plus any note about how it matched.
  if (typeof value.path === 'string' && value.changed !== undefined && ('replacements' in value || 'added' in value || 'bytes' in value || 'created' in value)) {
    const added = Number(value.added) || 0;
    const removed = Number(value.removed) || 0;
    const what = value.changed === false ? 'No change to ' + value.path + '.' : (value.created ? 'Created ' : 'Changed ') + value.path + (Number(value.replacements) > 1 ? ' in ' + value.replacements + ' places' : '') + ': ' + added + ' line' + (added === 1 ? '' : 's') + ' added, ' + removed + ' removed.';
    const notes = [value.note, value.warning].filter((note) => typeof note === 'string' && note);
    return [what, ...notes].join('\n') + (rest ? '\n' + rest : '');
  }
  // grep output: the lines as ripgrep prints them.
  if (Array.isArray(value.results) && typeof value.pattern === 'string' && value.results.every((row) => typeof row === 'string')) {
    const tail = [value.truncated ? '… more results not shown' : '', typeof value.note === 'string' ? value.note : '', typeof value.hint === 'string' ? value.hint : ''].filter(Boolean).join('\n');
    return (value.results.join('\n') || 'No matches.') + (tail ? '\n' + tail : '') + (rest ? '\n' + rest : '');
  }
  // A listing: one file per line.
  if (Array.isArray(value.files) && value.files.every((file) => typeof file === 'string')) {
    return (value.files.join('\n') || 'No files.') + (value.truncated ? '\n… more files not shown' : '') + (rest ? '\n' + rest : '');
  }
  // A plan update: the checklist is above, so one line on where it stands.
  if (Array.isArray(value.todos) && value.todos.every((todo) => todo && typeof todo === 'object')) {
    const done = value.todos.filter((todo) => todo.status === 'completed').length;
    return value.todos.length ? done + ' of ' + value.todos.length + ' done.' + (rest ? '\n' + rest : '') : 'The plan is empty.';
  }
  if ('exitCode' in value && ('stdout' in value || 'stderr' in value)) {
    const parts = [];
    const stdout = String(value.stdout || '').replace(/\s+$/, '');
    const stderr = String(value.stderr || '').replace(/\s+$/, '');
    if (stdout) parts.push(stdout + (value.stdoutTruncated ? '\n… (output cut short)' : ''));
    if (stderr) parts.push(stderr + (value.stderrTruncated ? '\n… (output cut short)' : ''));
    // A command past its time limit keeps running in the background (as Claude
    // Code and Codex do), so "Timed out" would be wrong: say where it went.
    if (value.movedToBackground) parts.push('Still running in the background after the time limit' + (value.id ? ' (' + value.id + ')' : '') + '. OASIS will say when it exits.');
    else if (value.timedOut) parts.push('Timed out.');
    else if (value.cancelled) parts.push('Stopped.');
    else if (!rest && value.exitCode !== 0 && value.exitCode !== null && value.exitCode !== undefined) parts.push('Exit code ' + value.exitCode + '.');
    if (rest) parts.push(rest);
    return parts.join('\n') || (value.exitCode === 0 ? 'Finished with no output.' : text);
  }
  return text;
}

// One quiet line under a finished step saying what came back, the way
// Claude Code writes "⎿ Read 48 lines" under a tool call: "Read lines
// 1–200 of 1,204", "3 matches in 2 files", "12 passed · 1 failed",
// "Exit code 2". Empty when the row already says it all (or it is running).
// Returns { text, tone } where tone is '' or 'fail'.
const plural = (count, word, many = word + 's') => count.toLocaleString('en-US') + ' ' + (count === 1 ? word : many);
export function testSummary(text) {
  const out = String(text || '');
  let passed, failed, skipped;
  const last = (pattern) => { let found; for (const match of out.matchAll(pattern)) found = match; return found ? Number(found[1]) : undefined; };
  passed = last(/^# pass (\d+)$/gm);
  failed = last(/^# fail (\d+)$/gm);
  if (passed === undefined) passed = last(/\b(\d+) (?:tests? )?(?:passed|passing)\b/gi);
  if (failed === undefined) failed = last(/\b(\d+) (?:tests? )?(?:failed|failing)\b/gi);
  skipped = last(/\b(\d+) (?:skipped|pending)\b/gi);
  if (passed === undefined && failed === undefined) return '';
  const parts = [];
  if (passed !== undefined) parts.push(passed.toLocaleString('en-US') + ' passed');
  if (failed) parts.push(failed.toLocaleString('en-US') + ' failed');
  if (skipped) parts.push(skipped.toLocaleString('en-US') + ' skipped');
  return parts.join(' · ');
}
export function stepResult(step = {}) {
  if (!step || step.ok === undefined) return { text: '', tone: '' };
  const text = String(step.content || '');
  const newline = text.indexOf('\n');
  const first = newline === -1 ? text : text.slice(0, newline);
  let value = null;
  if (first.startsWith('{"')) { try { value = JSON.parse(first); } catch { value = null; } }
  const none = { text: '', tone: '' };
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  if (step.ok && step.name === 'write_file' && typeof args.content === 'string') {
    const count = args.content ? args.content.replace(/\n$/, '').split('\n').length : 0;
    return { text: count ? 'Wrote ' + plural(count, 'line') : 'Wrote an empty file', tone: '' };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.error === 'string' && value.error) {
      const line = value.error.split('\n').find((row) => row.trim()) || '';
      return { text: line.length > 140 ? line.slice(0, 139) + '…' : line, tone: 'fail' };
    }
    if (typeof value.content === 'string' && typeof value.path === 'string' && !('exitCode' in value)) {
      const count = value.content ? value.content.split('\n').length : 0;
      const total = Number(value.totalLines);
      if (Number.isInteger(value.startLine) && Number.isInteger(value.endLine) && Number.isInteger(total) && (value.startLine > 1 || value.endLine < total)) {
        return { text: 'Read lines ' + value.startLine.toLocaleString('en-US') + '–' + value.endLine.toLocaleString('en-US') + ' of ' + total.toLocaleString('en-US'), tone: '' };
      }
      return { text: count ? 'Read ' + plural(count, 'line') : 'The file is empty', tone: '' };
    }
    if (Array.isArray(value.matches)) {
      if (!value.matches.length) return { text: 'No matches', tone: '' };
      const files = new Set(value.matches.map((match) => match && match.path).filter(Boolean)).size;
      const count = plural(value.matches.length, 'match', 'matches') + (value.truncated ? '+' : '');
      return { text: files > 1 ? count + ' in ' + plural(files, 'file') : count, tone: '' };
    }
    if (Array.isArray(value.results) && typeof value.pattern === 'string') {
      const rows = value.results.filter((row) => typeof row === 'string');
      const more = value.truncated ? '+' : '';
      if (!rows.length) return { text: 'No matches', tone: '' };
      if (value.mode === 'files_with_matches') return { text: plural(rows.length, 'file') + more, tone: '' };
      if (value.mode === 'count') {
        const total = rows.reduce((sum, row) => sum + (Number(/:(\d+)$/.exec(row)?.[1]) || 0), 0);
        return { text: plural(total, 'match', 'matches') + ' in ' + plural(rows.length, 'file') + more, tone: '' };
      }
      // Content rows are "path:12:text"; "path-12-text" rows are context around them.
      const hits = rows.map((row) => /^(.*?):\d+:/.exec(row)).filter(Boolean);
      if (!hits.length) return { text: plural(rows.length, 'line') + more, tone: '' };
      const files = new Set(hits.map((hit) => hit[1])).size;
      const count = plural(hits.length, 'match', 'matches') + more;
      return { text: files > 1 ? count + ' in ' + plural(files, 'file') : count, tone: '' };
    }
    if (Array.isArray(value.files)) return { text: value.files.length ? plural(value.files.length, 'file') + (value.truncated ? '+' : '') : 'No files', tone: '' };
    if (Array.isArray(value.todos)) return none;
    if (step.name === 'git_diff' && typeof value.stdout === 'string' && value.exitCode === 0) {
      const files = (value.stdout.match(/^diff --git /gm) || []).length;
      const added = (value.stdout.match(/^\+(?!\+\+)/gm) || []).length;
      const removed = (value.stdout.match(/^-(?!--)/gm) || []).length;
      return { text: files ? plural(files, 'file') + ' changed · +' + added + ' −' + removed : 'No changes', tone: '' };
    }
    if ('exitCode' in value && ('stdout' in value || 'stderr' in value)) {
      const output = String(value.stdout || '') + '\n' + String(value.stderr || '');
      const tests = testSummary(output);
      const failed = value.exitCode !== 0 && value.exitCode !== null && value.exitCode !== undefined;
      if (value.movedToBackground) return { text: 'Still running in the background', tone: '' };
      if (value.timedOut) return { text: 'Timed out', tone: 'fail' };
      if (value.cancelled) return { text: 'Stopped', tone: 'fail' };
      if (tests) return { text: tests + (failed ? ' · exit code ' + value.exitCode : ''), tone: failed || / failed/.test(tests) ? 'fail' : '' };
      if (failed) {
        const lines = String(value.stderr || value.stdout || '').split('\n').map((row) => row.trim()).filter(Boolean);
        const why = lines.find((row) => /error|not found|cannot|denied|no such|fail/i.test(row)) || lines[lines.length - 1] || '';
        const short = why.length > 110 ? why.slice(0, 109) + '…' : why;
        return { text: 'Exit code ' + value.exitCode + (short ? ' · ' + short : ''), tone: 'fail' };
      }
      const rows = String(value.stdout || '').replace(/\s+$/, '');
      return { text: rows ? plural(rows.split('\n').length, 'line') + ' of output' : 'No output', tone: '' };
    }
  }
  if (step.ok === false && text.trim()) {
    const line = text.split('\n').find((row) => row.trim()) || '';
    return { text: line.length > 140 ? line.slice(0, 139) + '…' : line.trim(), tone: 'fail' };
  }
  return none;
}

// The few lines worth showing inline for an edit (Claude Code prints the
// change under the step): every added and removed line with one line of
// context around each change, up to `max` lines. ops are lineDiff() rows.
// Returns { rows, more } where more counts the changed lines left out.
export function diffPreview(ops = [], max = 10) {
  const keep = new Set();
  ops.forEach((op, index) => {
    if (op.type !== 'add' && op.type !== 'del') return;
    keep.add(index);
    if (ops[index - 1] && ops[index - 1].type === 'same') keep.add(index - 1);
    if (ops[index + 1] && ops[index + 1].type === 'same') keep.add(index + 1);
  });
  const rows = [];
  let last = -1;
  let more = 0;
  for (const index of [...keep].sort((a, b) => a - b)) {
    const op = ops[index];
    if (rows.length >= max) { if (op.type !== 'same') more++; continue; }
    if (last >= 0 && index > last + 1) rows.push({ type: 'gap', text: '⋯' });
    rows.push(op);
    last = index;
  }
  while (rows.length && (rows[rows.length - 1].type === 'gap' || (rows[rows.length - 1].type === 'same' && more))) rows.pop();
  return { rows, more };
}

// True when a reply repeats, word for word, an earlier reply of the same
// turn (small models echo their summary after a verification nudge). The
// chat shows it once.
export function repeatsEarlierReply(entries = [], entry, text) {
  const key = String(text || '').replace(/\s+/g, ' ').trim();
  if (!key) return false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const other = entries[index];
    if (!other || other === entry) continue;
    if (other.role === 'user' && !other.steer) return false;
    if (other.role === 'assistant' && String(other.content || '').replace(/\s+/g, ' ').trim() === key) return true;
  }
  return false;
}
