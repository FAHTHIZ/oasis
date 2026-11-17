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

// Builds a reporter for one model reply. update(index, { id, name, args })
// takes the call's accumulated state; finish() sends a final report (done: true)
// for every call so a UI never keeps a stale byte count.
export function createDraftReporter(onDraft, { now = () => Date.now(), interval = DRAFT_INTERVAL_MS } = {}) {
  if (typeof onDraft !== 'function') return { update() {}, finish() {} };
  const calls = new Map();
  const send = (index, state, done = false) => {
    const target = draftTarget(state.args);
    const event = { index, id: state.id || '', name: state.name || '', chars: state.args.length, ...target, ...(done ? { done: true } : {}) };
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

// Words for a call still being written: "Writing src/app.mjs", "Preparing npm test".
const DRAFT_VERBS = {
  write_file: 'Writing', edit_file: 'Editing', multi_edit: 'Editing', apply_patch: 'Patching', notebook_edit: 'Editing',
  run_command: 'Preparing', run_shell: 'Preparing', powershell: 'Preparing', auto_test: 'Preparing',
  todo_write: 'Planning', task: 'Briefing a subagent', web_search: 'Preparing a search', fetch_url: 'Preparing to fetch'
};

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
  else if (verb) label = verb + (target ? ' ' + target : '');
  else label = 'Preparing ' + (name.replace(/^mcp__([^_]+)__/, '$1 ').replace(/[_-]+/g, ' ').trim() || 'a step');
  const size = Number(draft.chars) >= 512 && /^(Writing|Editing|Patching)$/.test(verb || '') ? formatBytes(draft.chars) : '';
  return { label, size, text: label + (size ? ' · ' + size : '') };
}
