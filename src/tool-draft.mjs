// Tool calls the model is still writing.
//
// A model streams a tool call's arguments before the call can run: a
// write_file with a 5 KB file, an edit with a long replacement, a command.
// That used to be dead air (the spinner said "Thinking" or nothing at all
// while the model was busy writing a file). The provider stream now reports
// each call as it grows, and the UIs show "Writing src/app.mjs · 3.2 KB".
//
// Reports are throttled per call: the first one as soon as the tool name is
// known, again when a target (path, command, query) first appears, and then
// at most every DRAFT_INTERVAL_MS while the arguments grow.

export const DRAFT_INTERVAL_MS = 120;

const STRING_FIELD = (name) => new RegExp('"' + name + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', 's');
const PATH_FIELDS = ['path', 'file_path', 'notebook_path'].map((name) => STRING_FIELD(name));
const COMMAND_FIELD = STRING_FIELD('command');
const QUERY_FIELDS = ['query', 'pattern', 'url', 'description'].map((name) => STRING_FIELD(name));
const ARGS_FIELD = /"args"\s*:\s*\[((?:\s*"(?:[^"\\]|\\.)*"\s*,?)*)/s;

function unescape(raw) {
  try { return JSON.parse('"' + raw.replace(/\\$/, '') + '"'); }
  catch { return raw.replace(/\\(.)/g, '$1'); }
}

// Pulls the target out of incomplete JSON ('{"path":"src/a.mjs","content":"…').
// A string still being written counts only once its closing quote arrived, so
// a half-typed path is never shown.
export function draftTarget(partialJson) {
  const text = String(partialJson || '');
  const complete = (regex) => {
    const match = regex.exec(text);
    if (!match) return '';
    const after = text.slice(match.index + match[0].length);
    return after.startsWith('"') ? unescape(match[1]) : '';
  };
  for (const regex of PATH_FIELDS) { const value = complete(regex); if (value) return { path: value }; }
  const command = complete(COMMAND_FIELD);
  if (command) {
    const list = ARGS_FIELD.exec(text);
    const args = list ? [...list[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unescape(m[1])) : [];
    return { command: [command, ...args].join(' ').trim() };
  }
  for (const regex of QUERY_FIELDS) { const value = complete(regex); if (value) return { query: value }; }
  return {};
}

// Lines a call still being written adds and removes, from its partial JSON:
// the file body of a write, the new and old text of an edit, the + and -
// lines of a patch. Cursor shows a step's +73 −12 as it is written; this is
// the same count before the step runs. Escaped newlines (\\n) are counted
// in the raw text, so nothing is parsed twice.
const ADDED_FIELDS = ['content', 'new_string', 'new_text', 'replacement', 'new_source'];
const REMOVED_FIELDS = ['old_string', 'old_text'];
const ADDS = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit']);
function fieldBodies(text, field) {
  const out = [];
  const regex = new RegExp('"' + field + '"\\s*:\\s*"', 'g');
  let match;
  while ((match = regex.exec(text))) {
    let end = match.index + match[0].length;
    const start = end;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    out.push(text.slice(start, Math.min(end, text.length)));
    regex.lastIndex = end;
  }
  return out;
}
function countLines(body) {
  if (!body) return 0;
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') continue;
    if (body[i + 1] === 'n') n++;
    i++;
  }
  return n + 1;
}
export function draftLines(name, partialJson) {
  const text = String(partialJson || '');
  if (name === 'apply_patch') {
    const body = fieldBodies(text, 'patch').concat(fieldBodies(text, 'input')).join('');
    let added = 0, removed = 0;
    for (const line of body.split('\\n').slice(1)) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
  }
  if (!ADDS.has(name)) return { added: 0, removed: 0 };
  const sum = (fields) => fields.reduce((n, field) => n + fieldBodies(text, field).reduce((m, body) => m + countLines(body), 0), 0);
  return { added: sum(ADDED_FIELDS), removed: sum(REMOVED_FIELDS) };
}

// Builds a reporter for one model reply. update(index, { id, name, args })
// takes the call's accumulated state; finish() sends a final report (done: true)
// for every call so a UI never keeps a stale byte count.
export function createDraftReporter(onDraft, { now = () => Date.now(), interval = DRAFT_INTERVAL_MS } = {}) {
  if (typeof onDraft !== 'function') return { update() {}, finish() {} };
  const calls = new Map();
  const send = (index, state, done = false) => {
    const target = draftTarget(state.args);
    const lines = draftLines(state.name, state.args);
    const event = { index, id: state.id || '', name: state.name || '', chars: state.args.length, ...target, ...(lines.added || lines.removed ? { lines } : {}), ...(done ? { done: true } : {}) };
    state.sentAt = now();
    state.key = event.name + '\u0000' + (target.path || target.command || target.query || '');
    state.sentChars = event.chars;
    try { onDraft(event); } catch {}
  };
  return {
    update(index, { id, name, args } = {}) {
      const state = calls.get(index) || { id: '', name: '', args: '', sentAt: 0, key: null, sentChars: -1 };
      if (id) state.id = id;
      if (typeof name === 'string' && name) state.name = name;
      if (typeof args === 'string') state.args = args;
      calls.set(index, state);
      if (!state.name) return;
      const target = draftTarget(state.args);
      const key = state.name + '\u0000' + (target.path || target.command || target.query || '');
      if (key !== state.key || (state.args.length !== state.sentChars && now() - state.sentAt >= interval)) send(index, state);
    },
    finish() {
      for (const [index, state] of calls) if (state.name) send(index, state, true);
      calls.clear();
    }
  };
}

// Words for a call still being written: "Writing src/app.mjs", "Preparing
// npm test", and what to say before its target has arrived ("Editing a
// file" rather than a bare "Editing" that then jumps to the path).
const DRAFT_VERBS = {
  write_file: 'Writing', edit_file: 'Editing', multi_edit: 'Editing', apply_patch: 'Patching', notebook_edit: 'Editing',
  run_command: 'Preparing', run_shell: 'Preparing', powershell: 'Preparing', auto_test: 'Preparing',
  todo_write: 'Planning', task: 'Briefing a subagent', web_search: 'Preparing a search', fetch_url: 'Preparing to fetch',
  read_file: 'Reading', list_files: 'Listing', search_files: 'Searching for', grep: 'Searching for', glob_files: 'Finding',
  git_status: 'Checking git status', git_diff: 'Reviewing changes', repo_map: 'Mapping the project', delete_file: 'Deleting'
};
const DRAFT_ALONE = {
  write_file: 'Writing a file', edit_file: 'Editing a file', multi_edit: 'Editing a file', apply_patch: 'Writing a patch', notebook_edit: 'Editing a notebook',
  run_command: 'Preparing a command', run_shell: 'Preparing a command', powershell: 'Preparing a command', auto_test: 'Preparing the tests',
  read_file: 'Choosing a file to read', list_files: 'Listing files', search_files: 'Searching the project', grep: 'Searching the project', glob_files: 'Finding files', delete_file: 'Deleting a file'
};
// Verbs that take no target words after them.
const WHOLE = new Set(['Briefing a subagent', 'Checking git status', 'Reviewing changes', 'Mapping the project']);

export function formatBytes(chars) {
  const n = Math.max(0, Number(chars) || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0).replace(/\.0$/, '') + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function shortPath(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : parts.join('/');
}

// One line for the live status: "Writing src/big.mjs · 3.2 KB".
export function describeDraft(draft = {}) {
  const name = String(draft.name || '');
  const verb = DRAFT_VERBS[name];
  const target = draft.path ? shortPath(draft.path) : draft.command ? String(draft.command).replace(/\s+/g, ' ').slice(0, 48) : draft.query ? String(draft.query).replace(/\s+/g, ' ').slice(0, 48) : '';
  let label;
  if (verb === 'Planning') label = 'Updating the plan';
  else if (verb && WHOLE.has(verb)) label = verb;
  else if (name === 'web_search' && target) label = 'Searching the web for ' + target;
  else if (name === 'fetch_url' && target) label = 'Fetching ' + target;
  else if (verb) label = target ? verb + ' ' + target : DRAFT_ALONE[name] || verb;
  else label = 'Preparing ' + (name.replace(/^mcp__([^_]+)__/, '$1 ').replace(/[_-]+/g, ' ').trim() || 'a step');
  const writes = /^(Writing|Editing|Patching)$/.test(verb || '');
  const size = Number(draft.chars) >= 512 && writes ? formatBytes(draft.chars) : '';
  // "+120 −4" once a body has more than a line; the size is the fallback.
  const added = Math.max(0, Number(draft.lines && draft.lines.added) || 0);
  const removed = Math.max(0, Number(draft.lines && draft.lines.removed) || 0);
  const diff = writes && added + removed >= 2 ? (removed ? '+' + added + ' −' + removed : '+' + added + ' lines') : '';
  const extra = diff || size;
  return { label, size, diff, text: label + (extra ? ' · ' + extra : '') };
}
