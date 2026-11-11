// Conversation timeline: how agent activity reads in the app.
//
// The app shows a task the way a person would narrate it: short prose
// updates from the agent, with the work in between folded into execution
// groups ("Edited math.mjs, ran the tests · 4 steps · 12s"). Each step in a
// group can be opened to inspect its exact input and output. Everything here
// is pure (no DOM), so it is shared by the live view and by restored chats,
// and it is unit tested in Node.

const SHELL = new Set(['run_command', 'run_shell', 'powershell', 'auto_test', 'bash', 'shell', 'command_output', 'kill_command', 'list_background']);
const READ = new Set(['read_file', 'read_notebook', 'notebook_read', 'list_files', 'list_directory', 'view_image']);
const EDIT = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'apply_patch', 'delete_file', 'move_file', 'rename_file']);
const SEARCH = new Set(['grep', 'search_files', 'glob_files', 'repo_map', 'lsp', 'diagnostics', 'ide_get_diagnostics', 'find_symbol']);
const WEB = new Set(['web_search', 'fetch_url', 'browser']);
const GIT = new Set(['git_diff', 'git_status', 'git_log', 'git_branch', 'git_commit', 'git_push', 'create_pull_request', 'github_push', 'worktree_inspect', 'worktree_merge']);
const AGENT = new Set(['task', 'agent_status', 'send_message', 'agent_stop', 'advisor', 'run_specialist_review']);
const PLAN = new Set(['todo_write', 'exit_plan_mode', 'ask_user_question', 'connect_service', 'load_skill', 'read_skill_resource', 'list_skills']);

export const STEP_KINDS = ['shell', 'read', 'edit', 'search', 'web', 'git', 'agent', 'plan', 'tool'];

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
  if (args.path || args.file_path) return String(args.path || args.file_path) + (args.offset ? ':' + args.offset : '');
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
  if (['run_command', 'run_shell', 'powershell', 'auto_test', 'bash', 'shell'].includes(name)) return isTestCommand(commandOf(args)) ? 'Ran the tests' : 'Ran a command';
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

// One line for a finished group: one step is named exactly ("Edited
// math.mjs"); more steps are summed up by kind ("Read 2 files, edited a
// file and ran the tests").
export function groupTitle(steps = []) {
  if (!steps.length) return 'Working';
  const running = steps.find((step) => step.ok === undefined);
  if (running) return liveLabel(running);
  if (steps.length === 1) return activityLabel(steps[0]);
  // Kinds in the order the work happened; a kind done once is named exactly.
  const byKind = new Map();
  for (const step of steps) {
    const kind = toolKind(step.name) === 'shell' && activityLabel(step) === 'Ran the tests' ? 'tests' : toolKind(step.name);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(step);
  }
  const lower = (text) => text ? text[0].toLowerCase() + text.slice(1) : text;
  const parts = [];
  for (const [kind, list] of byKind) {
    if (kind === 'tests') { parts.push('ran the tests'); continue; }
    // Files touched: count distinct paths, so three edits to one file read as one.
    const n = kind === 'read' || kind === 'edit' ? new Set(list.map((step) => baseName(step.args) || step.id)).size : list.length;
    parts.push(n === 1 ? lower(activityLabel(list[0])) : KIND_PHRASES[kind](n));
  }
  const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1) : parts[0];
  return sentence(list);
}

export function groupStats(steps = []) {
  const failed = steps.filter((step) => step.ok === false).length;
  const running = steps.filter((step) => step.ok === undefined).length;
  const starts = steps.map((step) => Number(step.startedAt)).filter(Number.isFinite);
  const ends = steps.map((step) => Number(step.endedAt)).filter(Number.isFinite);
  const durationMs = starts.length && ends.length && !running ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : null;
  return { total: steps.length, failed, running, durationMs };
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
