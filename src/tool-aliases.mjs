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
  // Read-only names other harnesses use for reading a file.
  view: [['read_file', compose(rename('file_path', 'path'), rename('filename', 'path'))]],
  viewfile: [['read_file', compose(rename('file_path', 'path'), rename('filename', 'path'))]],
  openfile: [['read_file', compose(rename('file_path', 'path'), rename('filename', 'path'))]],
  cat: [['read_file', compose(rename('file_path', 'path'), rename('filename', 'path'))]],
  readlines: [['read_file', rename('file_path', 'path')]],
  readfilelines: [['read_file', rename('file_path', 'path')]],
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
    }],
    // Without run_shell, a simple command line can still run as argv.
    ['run_command', (args) => {
      const argv = splitSimpleCommandLine(args.command);
      const next = argv ? { command: argv[0], args: argv.slice(1) } : { command: args.command, args: [] };
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

// "readlines_file" should still suggest read_file: every word of the real name
// (read, file) starts a word of the requested one.
function sharesEveryWord(requested, name) {
  const words = (value) => String(value || '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const asked = words(requested);
  const real = words(name);
  return real.length > 1 && real.every((word) => asked.some((part) => part.startsWith(word)));
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
// gpt-oss and other harmony-format models sometimes leak their channel tokens
// into the function name ("edit_file<|channel|>commentary") or keep the
// "functions." namespace. Providers then reject the echoed tool result with a
// 400 ("Names must match ^[a-zA-Z0-9_-]{1,64}$"), ending the whole run.
export function cleanToolCallName(name) {
  if (typeof name !== 'string') return name;
  let out = name.replace(/<\|[\s\S]*$/, '').trim().replace(/^(?:functions?|tools?)\./, '');
  if (!out) out = name.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(out)) out = out.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'unknown_tool';
  return out;
}

export function resolveToolAlias(requested, args, available) {
  const names = available instanceof Set ? available : new Set(available || []);
  if (!requested || names.has(requested)) return null;
  const key = squash(requested);
  for (const [target, mapArgs] of ALIASES[key] || []) {
    if (names.has(target)) return { name: target, args: mapArgs(args && typeof args === 'object' ? args : {}), aliasedFrom: requested };
  }
  // Same name with different casing or separators: ReadFile, read-file, readFile.
  for (const name of names) if (squash(name) === key) return { name, args, aliasedFrom: requested };
  // Singular/plural slips (search_file, read_files) are unambiguous; mapping
  // them saves a turn. Permission checks still apply to the real tool.
  const plural = [...names].filter((name) => squash(name) === key + 's' || squash(name) + 's' === key);
  if (plural.length === 1) return { name: plural[0], args, aliasedFrom: requested };
  const ranked = [...names]
    .map((name) => ({ name, score: Math.min(distance(key, squash(name)), squash(name).includes(key) || key.includes(squash(name)) ? 1 : Infinity, sharesEveryWord(requested, name) ? 3 : Infinity) }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .filter((item) => item.score <= Math.max(3, Math.floor(key.length / 3)))
    .slice(0, 3)
    .map((item) => item.name);
  return { error: 'There is no tool named "' + requested + '".' + (ranked.length ? ' Did you mean: ' + ranked.join(', ') + '?' : '') + ' Only call tools from your tool list.' };
}

// Characters that only mean something to a shell outside quotes. Inside double
// quotes a shell still expands $, ` and \, so those stay refused there too.
const SHELL_SYNTAX = /[|&;<>()$`*?[\]{}~!#\\]/;
const DOUBLE_QUOTE_SYNTAX = /[$`\\!]/;

/**
 * Split a simple command line ("python3 hello.py", "node -e 'x(1)'") into argv,
 * honouring single and double quotes. Returns null when the line needs a shell
 * (pipes, redirects, globs, variables, escapes, newlines) or a quote is unbalanced.
 */
export function splitSimpleCommandLine(line) {
  const text = String(line || '').trim();
  if (!text || /[\n\r]/.test(text)) return null;
  const argv = [];
  let current = '';
  let started = false;
  let quote = '';
  for (const char of text) {
    if (quote === "'") {
      if (char === "'") quote = '';
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (DOUBLE_QUOTE_SYNTAX.test(char)) return null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) { argv.push(current); current = ''; started = false; }
    } else if (SHELL_SYNTAX.test(char)) {
      return null;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) argv.push(current);
  // FOO=1 cmd is a shell variable assignment, not an executable named FOO=1.
  if (!argv.length || argv[0].includes('=')) return null;
  return argv;
}

/**
 * Models trained on Bash-style tools often send run_command a whole command
 * line ("python3 hello.py") instead of command plus args. Rewrite that into the
 * argv form when it is unambiguous, or onto run_shell when the line needs a
 * shell and run_shell is available. Anything else is returned unchanged, so the
 * normal "one executable path" error still explains the problem. The rewritten
 * call goes through the same permission and safety checks as any other.
 */
// Models sometimes send args as one string: a JSON array, a JavaScript-style
// array (with '...' or `...` literals), or a plain argument line. Returns the
// argv, or null when the string cannot be read unambiguously.
export function parseArgsString(text) {
  const raw = String(text);
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try { const value = JSON.parse(trimmed); if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) return value.map(String); } catch { /* try the JavaScript form */ }
    const out = [];
    let i = 1;
    const body = trimmed.slice(0, -1);
    const ESC = { n: '\n', t: '\t', r: '\r', '0': '\0', b: '\b', f: '\f', v: '\v' };
    while (i < body.length) {
      while (i < body.length && /[\s,]/.test(body[i])) i++;
      if (i >= body.length) break;
      const quote = body[i];
      if (!['"', "'", '`'].includes(quote)) return null;
      let value = '';
      i++;
      let closed = false;
      while (i < body.length) {
        const char = body[i];
        if (char === '\\') { const next = body[i + 1]; value += ESC[next] !== undefined ? ESC[next] : next; i += 2; continue; }
        if (char === quote) { closed = true; i++; break; }
        if (quote === '`' && char === '$' && body[i + 1] === '{') return null;
        value += char;
        i++;
      }
      if (!closed) return null;
      out.push(value);
    }
    return out;
  }
  return splitSimpleCommandLine(trimmed);
}

export function normalizeRunCommandCall(args, available) {
  if (!args || typeof args !== 'object') return null;
  if (typeof args.args === 'string' && typeof args.command === 'string' && args.command.trim() && !/\s/.test(args.command.trim())) {
    const argv = parseArgsString(args.args);
    return argv ? { name: 'run_command', args: { ...args, command: args.command.trim(), args: argv } } : null;
  }
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command || !/\s/.test(command)) return null;
  const extra = Array.isArray(args.args) ? args.args.map(String) : [];
  if (args.args !== undefined && !Array.isArray(args.args)) return null;
  const argv = splitSimpleCommandLine(command);
  if (argv) return { name: 'run_command', args: { ...args, command: argv[0], args: argv.slice(1).concat(extra) } };
  const names = available instanceof Set ? available : new Set(available || []);
  if (names.has('run_shell') && !extra.length && args.interactive !== true) {
    const next = { command };
    for (const key of ['timeoutSeconds', 'run_in_background', 'max_seconds']) if (args[key] !== undefined) next[key] = args[key];
    return { name: 'run_shell', args: next };
  }
  return null;
}
