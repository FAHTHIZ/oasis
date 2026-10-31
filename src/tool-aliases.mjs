// Tool alias resolution. Many models are trained on Claude Code style tool
// names (Read, Edit, Bash, Glob …) and argument shapes (file_path, timeout in
// milliseconds). Instead of failing those calls and letting the model retry
// blindly, map them onto the equivalent OASIS tool. Unknown names get a short
// "did you mean" list so the next attempt is right.

const rename = (from, to) => (args) => {
  const next = { ...args };
  if (Object.hasOwn(next, from) && !Object.hasOwn(next, to)) { next[to] = next[from]; delete next[from]; }
  return next;
};
const compose = (...fns) => (args) => fns.reduce((value, fn) => fn(value), args);

const ALIASES = {
  read: [['read_file', rename('file_path', 'path')]],
  write: [['write_file', rename('file_path', 'path')]],
  edit: [['edit_file', rename('file_path', 'path')]],
  multiedit: [['multi_edit', rename('file_path', 'path')]],
  notebookedit: [['notebook_edit', compose(rename('notebook_path', 'path'), rename('file_path', 'path'))]],
  bash: [
    ['run_shell', (args) => {
      const next = { command: args.command };
      if (args.timeout !== undefined) next.timeoutSeconds = Math.max(5, Math.min(600, Math.round(Number(args.timeout) / 1000) || 120));
      if (args.run_in_background !== undefined) next.run_in_background = args.run_in_background;
      return next;
    }]
  ],
  glob: [['glob_files', (args) => ({ pattern: args.path && args.pattern && !String(args.pattern).startsWith(String(args.path)) ? String(args.path).replace(/\/+$/, '') + '/' + args.pattern : args.pattern })]],
  grep: [['grep', (args) => args], ['search_files', (args) => ({ query: args.pattern, ...(args.path ? { path: args.path } : {}) })]],
  ls: [['list_files', (args) => ({ path: args.path || '.' })]],
  webfetch: [['fetch_url', (args) => ({ url: args.url })]],
  websearch: [['web_search', (args) => ({ query: args.query })]],
  todowrite: [['todo_write', (args) => args]],
  task: [['task', (args) => args]],
  bashoutput: [['command_output', compose(rename('bash_id', 'id'), rename('shell_id', 'id'))]],
  killshell: [['kill_command', compose(rename('shell_id', 'id'), rename('bash_id', 'id'))]],
  killbash: [['kill_command', compose(rename('shell_id', 'id'), rename('bash_id', 'id'))]]
};

function squash(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/**
 * Resolve a requested tool name against the available tools.
 * Returns { name, args, aliasedFrom } when it can be mapped, or
 * { error } with suggestions, or null when the name is already valid.
 */
export function resolveToolAlias(requested, args, available) {
  const names = available instanceof Set ? available : new Set(available || []);
  if (!requested || names.has(requested)) return null;
  const key = squash(requested);
  for (const [target, mapArgs] of ALIASES[key] || []) {
    if (names.has(target)) return { name: target, args: mapArgs(args && typeof args === 'object' ? args : {}), aliasedFrom: requested };
  }
  // Same name with different casing or separators: ReadFile, read-file, readFile.
  for (const name of names) if (squash(name) === key) return { name, args, aliasedFrom: requested };
  const ranked = [...names]
    .map((name) => ({ name, score: Math.min(distance(key, squash(name)), squash(name).includes(key) || key.includes(squash(name)) ? 1 : Infinity) }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .filter((item) => item.score <= Math.max(2, Math.floor(key.length / 3)))
    .slice(0, 3)
    .map((item) => item.name);
  return { error: 'There is no tool named "' + requested + '".' + (ranked.length ? ' Did you mean: ' + ranked.join(', ') + '?' : '') + ' Only call tools from your tool list.' };
}
