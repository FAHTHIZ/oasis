// Permission rules, permission modes, and command risk analysis.
//
// Permission rules accept familiar tool(specifier) forms so existing settings can migrate easily; OASIS applies its own policy and enforcement.
//   run_command(npm test:*)   prefix match on the command line ("npm test", "npm test -- --watch")
//   run_command(git status)   exact command line
//   edit_file(src/**)         glob over workspace-relative paths
//   fetch_url(domain:docs.python.org)
//   mcp_github                every tool from one MCP server (prefix), or an exact MCP tool name
//   Bash(...), Edit(...), Write(...), Read(...), WebFetch(...), Grep, Glob are accepted aliases.
// Precedence: deny > ask > allow > mode default.
import { discardReason } from './git-safety.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { normalizePermissionMode } from './permission-modes.mjs';

const TOOL_ALIASES = {
  bash: ['run_command', 'run_shell', 'monitor'],
  monitor: ['monitor'],
  listmcpresourcestool: ['list_mcp_resources'],
  memory: ['memory_save', 'memory_search', 'memory_read', 'memory_delete'],
  readmcpresourcetool: ['read_mcp_resource'],
  shell: ['run_shell'],
  powershell: ['powershell'],
  skill: ['load_skill'],
  workflow: ['workflow'],
  edit: ['edit_file', 'multi_edit', 'write_file', 'notebook_edit'],
  multiedit: ['multi_edit'],
  notebookedit: ['notebook_edit'],
  write: ['write_file'],
  read: ['read_file'],
  webfetch: ['fetch_url'],
  websearch: ['web_search'],
  diagnostics: ['diagnostics'],
  securityscan: ['security_scan'],
  scan: ['security_scan'],
  lsp: ['lsp'],
  git: ['git_commit', 'git_branch', 'git_push', 'create_pull_request'],
  gitcommit: ['git_commit'],
  pr: ['create_pull_request'],
  grep: ['grep', 'search_files', 'ast_grep'],
  astgrep: ['ast_grep'],
  glob: ['glob_files'],
  repomap: ['repo_map'],
  ls: ['list_files'],
  task: ['task'],
  todowrite: ['todo_write']
};

export const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file', 'notebook_edit']);
export const COMMAND_TOOLS = new Set(['run_command', 'run_shell', 'monitor', 'powershell']);

export function parseRule(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^([A-Za-z0-9_.-]+)(?:\((.*)\))?$/s);
  if (!match) return null;
  const name = match[1];
  const specifier = match[2] === undefined ? null : match[2].trim();
  const alias = TOOL_ALIASES[name.toLowerCase()];
  return { raw: text, tools: alias || [name], specifier, isMcpPrefix: /^mcp_/.test(name) && match[2] === undefined };
}

export function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}

export function commandLine(command, args = []) {
  return [String(command || ''), ...(Array.isArray(args) ? args : [])].join(' ').trim();
}

const BACKTICK = String.fromCharCode(96);

// Finds a matching closing parenthesis for simple command/process substitutions.
// Nested substitutions inside quoted substitutions are deliberately rejected as
// ambiguous; the permission system must ask rather than guess.
function findMatchingParen(text, openIndex) {
  let depth = 1;
  let quote = null;
  for (let i = openIndex + 1; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') { i++; continue; }
      if (char === '"') quote = null;
      else if ((char === '$' && text[i + 1] === '(') || char === BACKTICK) return -1;
      continue;
    }
    if (char === '\\') { i++; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === BACKTICK) return -1;
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findClosingBacktick(text, openIndex) {
  for (let i = openIndex + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === BACKTICK) return i;
  }
  return -1;
}

// A small, conservative shell-command splitter for permission decisions. It
// distinguishes quoted text from operators, inspects nested substitutions, and
// marks substitutions/redirections/grouping as unsafe for automatic approval.
// This is intentionally not a full shell parser: uncertain syntax fails closed.
function splitShellCommands(line, depth = 0) {
  const text = String(line || '').trim();
  if (!text) return { safe: false, commands: [] };
  if (depth > 8) return { safe: false, commands: [text] };

  const commands = [];
  let start = 0;
  let quote = null;
  let safe = true;

  const append = (end) => {
    const piece = text.slice(start, end).trim();
    if (!piece) safe = false;
    else commands.push(piece);
  };
  const addNested = (nestedText, nestedDepth) => {
    const nested = splitShellCommands(nestedText, nestedDepth);
    commands.push(...nested.commands);
    safe = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (char === '\\') { i++; continue; }
      if (char === '"') { quote = null; continue; }
      if (char === '$' && text[i + 1] === '(') {
        const close = findMatchingParen(text, i + 1);
        if (close < 0) return { safe: false, commands: [text, ...commands] };
        addNested(text.slice(i + 2, close), depth + 1);
        i = close;
        continue;
      }
      if (char === BACKTICK) {
        const close = findClosingBacktick(text, i);
        if (close < 0) return { safe: false, commands: [text, ...commands] };
        addNested(text.slice(i + 1, close), depth + 1);
        i = close;
      }
      continue;
    }

    if (char === '\\') {
      if (i === text.length - 1) safe = false;
      else i++;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }

    if (char === '$' && text[i + 1] === '(') {
      const close = findMatchingParen(text, i + 1);
      if (close < 0) return { safe: false, commands: [text, ...commands] };
      addNested(text.slice(i + 2, close), depth + 1);
      i = close;
      continue;
    }
    if (char === BACKTICK) {
      const close = findClosingBacktick(text, i);
      if (close < 0) return { safe: false, commands: [text, ...commands] };
      addNested(text.slice(i + 1, close), depth + 1);
      i = close;
      continue;
    }
    if (char === '<' && text[i + 1] === '(') {
      const close = findMatchingParen(text, i + 1);
      if (close < 0) return { safe: false, commands: [text, ...commands] };
      addNested(text.slice(i + 2, close), depth + 1);
      i = close;
      continue;
    }

    // Parenthesized shell groups and redirections are outside the deliberately
    // supported grammar. They need an interactive decision, never auto-approval.
    if (char === '(' || char === ')' || char === '<' || char === '>') safe = false;

    if (char === ';' || char === '&' || char === '|' || char === '\n' || char === '\r') {
      append(i);
      if ((char === '&' || char === '|') && text[i + 1] === char) i++;
      if (char === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    }
  }

  if (quote !== null) safe = false;
  if (start >= text.length) safe = false;
  else append(text.length);
  return { safe, commands };
}

function matchSingleCommandSpecifier(specifier, line) {
  if (specifier === null || specifier === '' || specifier === '*') return true;
  if (specifier.endsWith(':*')) {
    const prefix = specifier.slice(0, -2).trim();
    return line === prefix || line.startsWith(prefix + ' ');
  }
  if (specifier.includes('*')) return globToRegExp(specifier.replace(/\//g, '\u0000')).test(line.replace(/\//g, '\u0000'));
  return line === specifier;
}

// Splits one simple command into shell words: quotes and backslash escapes are
// removed, runs of spaces/tabs and line continuations collapse. Returns null for
// text this small parser does not understand (unbalanced quotes).
function shellWords(text) {
  const words = [];
  let current = '';
  let has = false;
  let quote = null;
  const source = String(text || '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote === "'") { if (char === "'") quote = null; else current += char; continue; }
    if (quote === '"') {
      if (char === '\\' && i + 1 < source.length && '"\\$`\n'.includes(source[i + 1])) { i++; if (source[i] !== '\n') current += source[i]; continue; }
      if (char === '"') { quote = null; continue; }
      current += char;
      continue;
    }
    if (char === '\\') { i++; if (i < source.length && source[i] !== '\n') { current += source[i]; has = true; } continue; }
    if (char === "'" || char === '"') { quote = char; has = true; continue; }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') { if (has) words.push(current); current = ''; has = false; continue; }
    current += char;
    has = true;
  }
  if (quote) return null;
  if (has) words.push(current);
  return words;
}

const DENY_WRAPPERS = new Set([...WRAPPERS_LIST(), 'sudo', 'doas', 'builtin', 'run0', 'pkexec']);
function WRAPPERS_LIST() { return ['env', 'nice', 'nohup', 'timeout', 'stdbuf', 'xargs', 'time', 'command', 'exec', 'ionice', 'chrt', 'taskset', 'setsid', 'unbuffer', 'caffeinate', 'flock', 'watch', 'strace', 'ltrace', 'faketime', 'firejail', 'nsenter', 'unshare', 'chroot']; }
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix', '--list-cmds', '--attr-source']);

function stripGitGlobals(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const flag = words[i].split('=')[0];
    i += GIT_VALUE_OPTIONS.has(flag) && !words[i].includes('=') && !/^-[Cc]./.test(words[i]) ? 2 : 1;
  }
  return i > 1 && i < words.length ? [words[0], ...words.slice(i)] : null;
}

// Every spelling a deny/ask rule must see for one command: the raw text, the
// unquoted single-spaced form, the program's basename, the command inside
// wrappers (env, sudo, nice, timeout, xargs, command, exec, eval, ...), the script
// of `bash -c` and friends, and `git` without global options (-C, -c, --no-pager).
// Without this, `Bash(git push:*)` missed `git  push`, `"git" push`, `\git push`,
// `env git push`, `sudo git push`, `bash -c "git push"` and `git -C . push`.
export function commandSpellings(piece, depth = 0) {
  const out = new Set([piece]);
  if (depth > 4) return out;
  let words = shellWords(piece);
  if (!words || !words.length) return out;
  for (let guard = 0; guard < 12 && words.length; guard++) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    if (!words.length) break;
    const base = executableBase(words[0]);
    const named = [base, ...words.slice(1)];
    out.add(words.join(' '));
    out.add(named.join(' '));
    if (base === 'git') { const plain = stripGitGlobals(named); if (plain) out.add(plain.join(' ')); }
    if (base === 'eval') {
      for (const inner of splitShellCommands(words.slice(1).join(' '), depth + 1).commands) for (const spelling of commandSpellings(inner, depth + 1)) out.add(spelling);
      break;
    }
    if (SHELLS.has(base)) {
      let index = 1;
      if (base === 'busybox' && SHELLS.has(String(words[1] || ''))) index = 2;
      let script = null;
      for (; index < words.length; index++) {
        if (/^-[a-z]*c[a-z]*$/i.test(words[index]) && !words[index].startsWith('--')) { script = words[index + 1]; break; }
        if (!words[index].startsWith('-')) break;
      }
      if (typeof script === 'string') for (const inner of splitShellCommands(script, depth + 1).commands) for (const spelling of commandSpellings(inner, depth + 1)) out.add(spelling);
      break;
    }
    if (!DENY_WRAPPERS.has(base)) break;
    let inner;
    if (base === 'sudo' || base === 'doas' || base === 'run0' || base === 'pkexec') {
      let i = 1;
      const valued = new Set(['-u', '--user', '-g', '--group', '-C', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user']);
      while (i < words.length && words[i].startsWith('-')) { const flag = words[i]; i++; if (flag === '--') break; if (valued.has(flag)) i++; }
      inner = i < words.length ? [words[i], words.slice(i + 1)] : null;
    } else if (base === 'builtin' || base === 'time' || base === 'nohup' || base === 'setsid' || base === 'unbuffer' || base === 'caffeinate') {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i++;
      inner = i < words.length ? [words[i], words.slice(i + 1)] : null;
    } else inner = unwrap(base, words.slice(1));
    if (!inner) break;
    words = [inner[0], ...inner[1]];
  }
  return out;
}

function matchCommandSpecifier(specifier, line, options = {}) {
  const parsed = splitShellCommands(line);
  if (!parsed.commands.length) return false;

  // Deny/ask rules need to catch any matching piece, even when the whole line
  // is too complex for approval, and in any spelling of it. Allow rules require
  // a safe parse and a literal match for every simple command (including
  // commands found in substitutions).
  if (options.requireEveryCommand === false) {
    return parsed.commands.some((piece) => [...commandSpellings(piece)].some((spelling) => matchSingleCommandSpecifier(specifier, spelling)));
  }
  if (!parsed.safe) return false;
  return parsed.commands.every((piece) => matchSingleCommandSpecifier(specifier, piece));
}

function normalizeRelative(p, root = process.cwd()) {
  const value = String(p || '').trim();
  if (!value) return '';
  const workspace = path.resolve(root);
  const absolute = path.resolve(workspace, value.replace(/\\/g, path.sep));
  const relative = path.relative(workspace, absolute);
  const insideWorkspace = relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  const normalized = insideWorkspace ? relative : absolute;
  return normalized.split(path.sep).join('/').replace(/^\.\//, '').toLowerCase();
}

const SHELL_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'mawk', 'cut', 'sort', 'uniq', 'wc', 'nl', 'tac', 'od', 'xxd', 'hexdump', 'strings', 'base64', 'base32', 'diff', 'cmp', 'jq', 'yq', 'source', '.', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'tr', 'fold', 'paste', 'comm', 'join', 'iconv', 'sha1sum', 'sha256sum', 'sha512sum', 'md5sum', 'shasum', 'cksum', 'cp', 'scp', 'rsync', 'tar', 'zip', 'gzip', 'zcat', 'bzcat', 'xzcat', 'dd', 'curl', 'look', 'expand', 'split', 'csplit', 'pr', 'fmt', 'column']);
const SHELL_WRITERS = new Set(['rm', 'rmdir', 'mv', 'tee', 'touch', 'truncate', 'chmod', 'chown', 'chgrp', 'ln', 'shred', 'unlink', 'mkdir', 'install', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'dd', 'patch', 'rsync']);

// Files a shell line reads and writes, as far as a static look can tell: the
// arguments of well-known file commands (cat, grep, rm, mv, tee, sed -i, ...)
// and redirection targets. Variables and globs are not expanded.
export function shellFileTargets(line) {
  const reads = new Set();
  const writes = new Set();
  const commands = splitShellCommands(String(line || '')).commands;
  for (const piece of commands) {
    for (const spelling of commandSpellings(piece)) {
      const words = shellWords(spelling);
      if (!words || !words.length) continue;
      const base = executableBase(words[0]);
      const operands = [];
      for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const redirect = word.match(/^(\d*|&)(>>?|<|>\|)(&?)(.*)$/);
        if (redirect) {
          if (redirect[3]) continue;
          const target = redirect[4] || words[++i] || '';
          if (!target || target.startsWith('/dev/')) continue;
          (redirect[2] === '<' ? reads : writes).add(target);
          continue;
        }
        if (base === 'dd' && /^(if|of)=/.test(word)) { (word.startsWith('if=') ? reads : writes).add(word.slice(3)); continue; }
        if (word.startsWith('-') && word !== '-') {
          const eq = word.indexOf('=');
          if (eq > 0 && /^--(file|output|input|in|out)/.test(word)) operands.push(word.slice(eq + 1));
          continue;
        }
        operands.push(word);
      }
      if (SHELL_READERS.has(base)) for (const operand of operands) reads.add(operand);
      const inPlace = (base === 'sed' || base === 'perl') && words.some((word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place'));
      if (SHELL_WRITERS.has(base) || inPlace) for (const operand of operands) writes.add(operand);
      if (base === 'cp' && operands.length > 1) writes.add(operands[operands.length - 1]);
    }
  }
  const clean = (set) => [...set].filter((value) => value && !/^[a-z]+:\/\//i.test(value));
  return { reads: clean(reads), writes: clean(writes) };
}

export function ruleMatches(rule, toolName, args = {}, options = {}) {
  if (!rule) return false;
  if (rule.isMcpPrefix) return toolName === rule.tools[0] || toolName.startsWith(rule.tools[0] + '_');
  // Read(...) and Edit(...) deny/ask rules also cover shell commands that touch
  // the same files (`cat .env`, `sed -i ... secrets/x`, `echo > secrets/x`).
  if (options.requireEveryCommand === false && rule.specifier && !rule.tools.includes(toolName) &&
      (toolName === 'run_shell' || toolName === 'run_command' || toolName === 'monitor')) {
    const coversRead = rule.tools.includes('read_file');
    const coversWrite = rule.tools.some((tool) => EDIT_TOOLS.has(tool));
    if (!coversRead && !coversWrite) return false;
    const line = toolName === 'run_shell' ? String(args.command || '') : commandLine(args.command, args.args);
    if (!line.trim()) return false;
    const targets = shellFileTargets(line);
    const candidates = [...(coversRead ? targets.reads : []), ...(coversWrite ? targets.writes : [])];
    const fileTool = coversRead ? 'read_file' : rule.tools.find((tool) => EDIT_TOOLS.has(tool));
    return candidates.some((candidate) => ruleMatches(rule, fileTool, { path: candidate }, options));
  }
  if (!rule.tools.includes(toolName)) return false;
  if (toolName === 'run_command' || toolName === 'monitor') {
    if (toolName === 'monitor' && !args.command) return false;
    if (matchCommandSpecifier(rule.specifier, commandLine(args.command, args.args), { requireEveryCommand: options.requireEveryCommand !== false })) return true;
    // Deny/ask rules also catch the same program called by path (rm:* blocks /bin/rm).
    return Boolean(options.matchBasename) && /[\\/]/.test(String(args.command || '')) && matchCommandSpecifier(rule.specifier, commandLine(path.basename(String(args.command)), args.args), { requireEveryCommand: options.requireEveryCommand !== false });
  }
  if (toolName === 'workflow') { const name = String(args.name || ''); const spec = rule.specifier.replace(/:\*$/, '*'); return spec.endsWith('*') ? name.startsWith(spec.slice(0, -1)) : name === spec; }
  if (toolName === 'load_skill') { const name = String(args.name || ''); const spec = rule.specifier.replace(/:\*$/, '*'); return spec.endsWith('*') ? name.startsWith(spec.slice(0, -1)) : name === spec; }
  if (toolName === 'run_shell' || toolName === 'powershell') return matchCommandSpecifier(rule.specifier, String(args.command || '').trim(), { requireEveryCommand: options.requireEveryCommand !== false });
  if (rule.specifier === null || rule.specifier === '' || rule.specifier === '*') return true;
  if (toolName === 'fetch_url') {
    if (rule.specifier.startsWith('domain:')) {
      try {
        const host = new URL(String(args.url)).hostname.toLowerCase();
        const domain = rule.specifier.slice('domain:'.length).toLowerCase();
        return host === domain || host.endsWith('.' + domain);
      } catch { return false; }
    }
    return String(args.url || '') === rule.specifier;
  }
  const root = options.root || process.cwd();
  const raw = args.path || args.pattern || '';
  const candidate = normalizeRelative(raw, root);
  if (!candidate) return false;
  const pattern = globToRegExp(normalizeRelative(rule.specifier, root));
  if (pattern.test(candidate)) return true;
  // Deny/ask rules also follow symlinks: a link (or a link to a parent folder)
  // pointing at .env must not dodge Read(.env).
  if (options.requireEveryCommand === false) {
    const real = resolvedRealPath(raw, root);
    if (real) return pattern.test(normalizeRelative(real.path, real.root));
  }
  return false;
}

function realpathOrNull(target) {
  try { return fs.realpathSync.native(target); } catch { return null; }
}

// Real location of a path, resolving symlinks in the deepest existing ancestor so
// a not-yet-created file under a linked folder still resolves. Null when nothing
// changes.
export function resolvedRealPath(value, root = process.cwd()) {
  const text = String(value || '').trim();
  if (!text) return null;
  const workspace = path.resolve(root);
  const absolute = path.resolve(workspace, text.replace(/\\/g, path.sep));
  let existing = absolute;
  const rest = [];
  let real = null;
  for (let guard = 0; guard < 64; guard++) {
    real = realpathOrNull(existing);
    if (real) break;
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  if (!real) return null;
  const resolved = rest.length ? path.join(real, ...rest) : real;
  const realRoot = realpathOrNull(workspace) || workspace;
  if (resolved === absolute && realRoot === workspace) return null;
  return { path: resolved, root: realRoot };
}

export class PermissionPolicy {
  constructor(settings = {}, options = {}) {
    const permissions = settings.permissions || {};
    this.allow = (permissions.allow || []).map(parseRule).filter(Boolean);
    this.ask = (permissions.ask || []).map(parseRule).filter(Boolean);
    this.deny = (permissions.deny || []).map(parseRule).filter(Boolean);
    this.sessionAllow = [];
    this.root = path.resolve(options.root || process.cwd());
    this.mode = normalizePermissionMode(options.mode) || normalizePermissionMode(permissions.defaultMode) || 'default';
  }

  setMode(mode) {
    const normalized = normalizePermissionMode(mode);
    if (!normalized) throw new Error('Unknown permission mode: ' + String(mode));
    this.mode = normalized;
  }

  rememberForSession(rawRule) {
    const rule = parseRule(rawRule);
    if (rule) this.sessionAllow.push(rule);
    return Boolean(rule);
  }

  addRule(kind, rawRule) {
    const rule = parseRule(rawRule);
    if (!rule) return false;
    this[kind].push(rule);
    return true;
  }

  // Returns { decision: 'deny'|'ask'|'allow'|'default', rule }.
  evaluate(toolName, args = {}) {
    const matchOptions = { root: this.root, matchBasename: true, requireEveryCommand: false };
    for (const rule of this.deny) if (ruleMatches(rule, toolName, args, matchOptions)) return { decision: 'deny', rule: rule.raw };
    for (const rule of this.ask) if (ruleMatches(rule, toolName, args, matchOptions)) return { decision: 'ask', rule: rule.raw };
    for (const rule of this.allow) if (ruleMatches(rule, toolName, args, { root: this.root })) return { decision: 'allow', rule: rule.raw };
    for (const rule of this.sessionAllow) if (ruleMatches(rule, toolName, args, { root: this.root })) return { decision: 'allow', rule: rule.raw, session: true };
    return { decision: 'default', rule: null };
  }

  // When a shell command falls through to a prompt even though an allow rule covers
  // part of it, explain why (the common "I allowed git:* and it still asks" confusion).
  allowNearMiss(toolName, args = {}) {
    if (!['run_command', 'run_shell', 'monitor', 'powershell'].includes(toolName)) return '';
    const line = toolName === 'run_shell' || toolName === 'powershell' ? String(args.command || '').trim() : commandLine(args.command, args.args);
    const rules = [...this.allow, ...this.sessionAllow].filter((rule) => rule.tools.includes(toolName));
    const partial = rules.find((rule) => ruleMatches(rule, toolName, args, { root: this.root, requireEveryCommand: false }));
    if (!partial) return '';
    const parsed = splitShellCommands(line);
    if (!parsed.safe) {
      const what = /\$\(|`/.test(line) ? 'command substitution ($(...) or backticks)' : /<\(|>\(/.test(line) ? 'process substitution' : /[<>]/.test(line) ? 'a redirect' : 'grouping or syntax the permission parser does not trust';
      return 'Why this asks: your allow rule ' + partial.raw + ' matches part of this command, but it uses ' + what + ', which allow rules never auto-approve. Splitting it into separate plain commands lets the rule apply.';
    }
    const uncovered = parsed.commands.filter((piece) => !rules.some((rule) => matchSingleCommandSpecifier(rule.specifier, piece)));
    if (!uncovered.length) return '';
    return 'Why this asks: your allow rule ' + partial.raw + ' covers part of this command, but not ' + uncovered.slice(0, 3).map((piece) => JSON.stringify(piece.length > 60 ? piece.slice(0, 57) + '...' : piece)).join(', ') + '. Every command joined with &&, ||, ; or | must be allowed for it to run without asking.';
  }

  describe() {
    return {
      mode: this.mode,
      allow: this.allow.map((r) => r.raw),
      ask: this.ask.map((r) => r.raw),
      deny: this.deny.map((r) => r.raw),
      session: this.sessionAllow.map((r) => r.raw)
    };
  }
}

// Suggest a reusable "always allow" rule after an approval.
export function suggestRule(toolName, args = {}) {
  if (toolName === 'monitor') return args.command ? suggestRule('run_command', args).replace(/^run_command\(/, 'Bash(') : null;
  if (toolName === 'run_command') {
    // Keep explicit paths: allowing "node" must not also allow ./some/dir/node.
    const raw = String(args.command || '');
    const command = /[\\/]/.test(raw) ? raw : path.basename(raw);
    const first = Array.isArray(args.args) && args.args[0] && !String(args.args[0]).startsWith('-') ? ' ' + args.args[0] : '';
    return 'run_command(' + command + first + ':*)';
  }
  if (toolName === 'run_shell' || toolName === 'powershell') {
    const words = String(args.command || '').trim().split(/\s+/).slice(0, 2).join(' ');
    return words ? (toolName === 'powershell' ? 'PowerShell(' : 'run_shell(') + words + ':*)' : null;
  }
  if (toolName === 'fetch_url') {
    try { return 'fetch_url(domain:' + new URL(String(args.url)).hostname + ')'; } catch { return null; }
  }
  if (toolName.startsWith('mcp_')) return toolName;
  return toolName;
}

// ---------------------------------------------------------------------------
// Command analysis. The general command tool runs one executable with an argv
// array and shell:false. A name denylist alone is easy to sidestep (`env rm`,
// `node -e`, `find -delete`), so wrappers are unwrapped and inline-code /
// arbitrary-exec flags are classified as high risk. High-risk commands always
// need interactive approval, even with --yes, unless an explicit allow rule
// names them.

export const BLOCKED_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ash', 'ksh', 'csh', 'tcsh', 'mksh', 'nu', 'xonsh', 'elvish', 'busybox',
  'cmd', 'powershell', 'pwsh',
  'sudo', 'su', 'doas', 'pkexec', 'runas',
  'rm', 'rmdir', 'del', 'erase', 'rd', 'format', 'mkfs', 'dd', 'shred', 'wipefs', 'fdisk', 'sfdisk', 'parted', 'diskpart',
  'shutdown', 'reboot', 'poweroff', 'halt', 'init',
  'mount', 'umount', 'chmod', 'chown', 'chgrp', 'chattr'
]);

const WRAPPERS = new Set(['env', 'nice', 'nohup', 'timeout', 'stdbuf', 'xargs', 'time', 'command', 'exec', 'ionice', 'chrt', 'taskset', 'setsid', 'unbuffer', 'caffeinate', 'flock', 'watch', 'strace', 'ltrace', 'script', 'faketime', 'firejail', 'nsenter', 'unshare', 'chroot']);

const INTERPRETER_EVAL_FLAGS = {
  node: ['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader'],
  nodejs: ['-e', '--eval', '-p', '--print', '-r', '--require', '--import'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  python: ['-c'], python2: ['-c'], python3: ['-c'], py: ['-c'], pypy: ['-c'], pypy3: ['-c'],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], lua: ['-e'], luajit: ['-e'], tclsh: [], wish: [],
  osascript: ['-e'], Rscript: ['-e'], rscript: ['-e'], julia: ['-e', '--eval']
};

const PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
  '--prefix', '--workspace', '-w', '--userconfig', '--globalconfig', '--cache',
  '--registry', '--script-shell', '--install-strategy', '--omit', '--include',
  '--cpu', '--os', '--libc', '--loglevel', '--fetch-retries', '--fetch-timeout',
  '--node-options', '--maxsockets', '--dir', '-c', '--config', '--store-dir',
  '--global-dir', '--package-import-method', '--network-concurrency', '--cwd',
  '--cache-folder', '--modules-folder', '--ignore-path', '--network-timeout', '--mutex',
  '--tag', '--access', '--otp', '--scope', '--workspace-prefix', '--reporter',
  '--lockfile-dir', '--hoist-pattern', '--modules-dir', '--use-yarnrc', '--har'
]);

const PACKAGE_MANAGER_BOOLEAN_FLAGS = new Set([
  '--silent', '-s', '--quiet', '-q', '--global', '-g', '--offline',
  '--prefer-offline', '--no-audit', '--no-fund', '--ignore-scripts',
  '--save-exact', '-e', '--production', '--dry-run', '--json', '--recursive', '-r',
  '--workspace-root', '--no-optional', '--prefer-online', '--strict-peer-deps',
  '--no-strict-peer-deps', '--no-verify', '--no-progress', '--frozen-lockfile',
  '--lockfile-only', '--no-lockfile', '--unsafe-perm', '--yes', '-y', '--force', '-f',
  '--verbose', '--no-emoji', '--emoji', '--ignore-engines', '--immutable',
  '--immutable-cache', '--check-cache', '--inline-builds', '--version', '-v', '--help', '-h', '--where', '--which', '--location'
]);

function packageManagerAction(args) {
  const values = args.map((arg) => String(arg).toLowerCase());
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--') {
      const verb = values[index + 1];
      return verb ? { verb, rest: values.slice(index + 2) } : null;
    }
    if (PACKAGE_MANAGER_VALUE_OPTIONS.has(value)) { index += 1; continue; }
    if (PACKAGE_MANAGER_BOOLEAN_FLAGS.has(value)) continue;
    if (value.startsWith('--') && value.includes('=')) continue;
    if (value.startsWith('-')) return { verb: null, rest: [], uncertain: true };
    return { verb: value, rest: values.slice(index + 1) };
  }
  return null;
}

function projectRunnerRisk(base, args) {
  const values = args.map((arg) => String(arg).toLowerCase());
  const first = values[0] || '';
  const packageAction = ['npm', 'pnpm', 'yarn'].includes(base) ? packageManagerAction(args) : null;
  if (packageAction?.uncertain) return true;
  const action = packageAction?.verb || first;
  const actionArgs = packageAction?.rest || values.slice(1);
  const scriptName = actionArgs[0] || '';

  if (['npx', 'bunx'].includes(base)) return true;
  if (['npm', 'pnpm', 'yarn'].includes(base)) {
    if (['exec', 'dlx'].includes(action)) return true;
    if (['install', 'add', 'update', 'link', 'publish'].includes(action)) return true;
    if (['run', 'run-script'].includes(action)) {
      return Boolean(scriptName) && !/^test(?:$|:)/.test(scriptName) &&
        !['check', 'lint', 'typecheck', 'format:check'].includes(scriptName);
    }
  }
  if (base === 'cargo' && first === 'run') return true;
  if (base === 'go' && ['run', 'generate'].includes(first)) return true;
  if (['make', 'gmake', 'just', 'task'].includes(base) &&
      ['deploy', 'release', 'publish', 'install', 'production'].includes(first)) return true;
  return false;
}

export function executableBase(command) {
  return path.basename(String(command || '')).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

function unwrap(base, args) {
  // Return [innerCommand, innerArgs] for a wrapper, or null when no inner command is present.
  let i = 0;
  const skipFlags = (withValue = new Set()) => {
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '--') { i++; break; }
      const flag = args[i].split('=')[0];
      i++;
      if (withValue.has(flag) && !args[i - 1].includes('=')) i++;
    }
  };
  if (base === 'env') {
    skipFlags(new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']));
    while (i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i])) i++;
  } else if (base === 'timeout') {
    skipFlags(new Set(['-s', '--signal', '-k', '--kill-after']));
    i++; // duration
  } else if (base === 'nice' || base === 'ionice' || base === 'chrt' || base === 'taskset') {
    skipFlags(new Set(['-n', '--adjustment', '-c', '--class', '-p']));
    if (base === 'chrt' || base === 'taskset') i++;
  } else if (base === 'xargs') {
    skipFlags(new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--arg-file', '--max-args', '--max-procs', '--delimiter']));
  } else if (base === 'flock') {
    skipFlags(new Set(['-w', '--timeout', '-E', '--conflict-exit-code']));
    i++; // lock file
  } else {
    skipFlags(new Set(['-o', '-n', '-d', '-c', '-t']));
  }
  if (i >= args.length) return null;
  return [args[i], args.slice(i + 1)];
}

// Returns { blocked?: string, highRisk?: string, effective: { base, args } }.
export function analyzeCommand(command, args = [], depth = 0) {
  const raw = String(command || '');
  if (!/^[a-zA-Z0-9_./:\\@+-]+$/.test(raw)) return { blocked: 'Command must be one executable path; shell syntax is not accepted.' };
  const base = executableBase(raw);
  if (BLOCKED_EXECUTABLES.has(base) || /^mkfs\./.test(base)) {
    if (['rm', 'rmdir', 'del', 'erase', 'rd'].includes(base)) return { blocked: 'This executable is blocked by Oasis safety policy: ' + base + '. To remove a single file, use the delete_file tool (it snapshots the file first so /rewind can restore it).' };
    return { blocked: 'This executable is blocked by Oasis safety policy: ' + base + '. Use a narrow supported tool instead.' };
  }
  const lowered = args.map((a) => String(a).toLowerCase());
  const joined = lowered.join(' ');
  // GNU env's -S/--split-string parses a command line inside one argument. The
  // normal wrapper parser cannot safely inspect that nested command, so reject
  // this form rather than allowing --yes or a broad rule to hide a shell/runtime.
  if (base === 'env' && args.some((arg) => {
    const value = String(arg);
    return value === '-S' || value.startsWith('-S') || value === '--split-string' || value.startsWith('--split-string=');
  })) {
    return { blocked: 'env -S/--split-string hides a nested executable from command safety checks. Pass the executable and each argument directly instead.' };
  }
  if (WRAPPERS.has(base)) {
    if (depth > 4) return { blocked: 'Too many nested command wrappers.' };
    const inner = unwrap(base, args.map(String));
    if (!inner) return { blocked: 'Could not safely inspect the nested executable used by the ' + base + ' wrapper. Pass the executable and its arguments directly instead.' };
    const result = analyzeCommand(inner[0], inner[1], depth + 1);
    if (result.blocked) return { blocked: result.blocked + ' (reached through the ' + base + ' wrapper)' };
    return { ...result, highRisk: result.highRisk || ('runs another program through the ' + base + ' wrapper') };
  }
  if (base === 'git') {
    const sub = args.find((a) => !String(a).startsWith('-'));
    if ((sub === 'reset' && args.includes('--hard')) ||
        (sub === 'clean' && args.some((a) => /^-[a-z]*f/i.test(a) || a === '--force')) ||
        (sub === 'push' && args.some((a) => /force|^-[a-z]*f/i.test(a) || /^\+/.test(a)))) {
      return { blocked: 'This destructive Git command is blocked by default.' };
    }
    if (args.some((a) => a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path') || a.startsWith('--upload-pack') || a.startsWith('--receive-pack'))) {
      return { highRisk: 'git configuration overrides can execute arbitrary programs', effective: { base, args } };
    }
    if (((sub === 'checkout' || sub === 'restore') && args.some((a) => a === '.' || a === '--' )) || discardReason(args.map(String))) {
      return { highRisk: 'discards uncommitted changes (OASIS saves a safety snapshot under refs/oasis/safety first)', effective: { base, args } };
    }
    if (sub === 'branch' && args.some((a) => a === '-D')) return { highRisk: 'force-deletes a branch', effective: { base, args } };
  }
  if (['npm', 'pnpm', 'yarn'].includes(base)) {
    const action = packageManagerAction(args);
    if (action?.uncertain) return { blocked: 'Unrecognized package-manager option ordering is blocked by default.' };
    if (action?.verb === 'publish') return { blocked: 'Publishing a package is blocked by default.' };
  }
  if (base === 'gh' && lowered[0] === 'repo' && lowered[1] === 'delete') return { blocked: 'Deleting a remote repository is blocked by default.' };
  if (joined.includes('rm -rf') || joined.includes('rm -fr') || joined.includes('format c:')) return { blocked: 'The command contains a destructive operation and is blocked.' };
  if (['apt', 'apt-get', 'dnf', 'yum', 'pacman', 'brew', 'winget', 'choco', 'snap', 'zypper', 'apk'].includes(base) && /\b(remove|purge|uninstall|autoremove|erase)\b/.test(joined)) {
    return { blocked: 'Package removal through the general command tool is blocked. Use an explicit package-manager action and review it first.' };
  }
  const evalFlags = INTERPRETER_EVAL_FLAGS[base] || (/^python\d+(\.\d+)?$/.test(base) ? ['-c'] : null);
  if (evalFlags) {
    const hit = args.find((a) => evalFlags.includes(String(a).split('=')[0]) || /^-[a-zA-Z]*c$/.test(a) && evalFlags.includes('-c'));
    if (hit) return { highRisk: 'runs inline code (' + base + ' ' + hit + ')', effective: { base, args } };
  }
  // Inline evaluation is handled above. In addition, flag explicit remote
  // package execution and high-impact project-runner verbs. Ordinary script/test
  // invocations retain the established interaction model.
  if (projectRunnerRisk(base, args)) {
    return {
      highRisk: 'executes a remote package or an explicit high-impact project runner',
      effective: { base, args }
    };
  }
  if (base === 'find' && args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a))) {
    return { highRisk: 'find can delete files or execute programs', effective: { base, args } };
  }
  if ((base === 'awk' || base === 'gawk' || base === 'mawk' || base === 'nawk') && /system\s*\(|\|\s*"|getline/.test(args.join(' '))) {
    return { highRisk: 'awk program runs subprocesses', effective: { base, args } };
  }
  if ((base === 'sed' || base === 'gsed') && args.some((a) => /(^|;)\s*e\b|\/e$|\/[gip]*e[gip]*$/.test(a))) {
    return { highRisk: 'sed program can execute commands', effective: { base, args } };
  }
  if (['taskkill', 'tskill', 'xkill', 'stop-process', 'osascript'].includes(base) || (base === 'fuser' && args.some((a) => /^-\w*k/.test(a)))) {
    return { highRisk: base + ' can close or kill applications the user has open', effective: { base, args } };
  }
  // Desktop automation drives the user's real windows and keyboard: it can close
  // apps, type into open documents, or quit them without saving.
  if (['wmctrl', 'xdotool', 'ydotool', 'cliclick', 'nircmd', 'nircmdc', 'autohotkey', 'autohotkey64', 'autohotkeyu64', 'xte'].includes(base)) {
    return { highRisk: base + ' controls windows or sends input to applications the user has open', effective: { base, args } };
  }
  if (['tmux', 'screen'].includes(base) && args.some((a) => /^(kill-server|kill-session|kill-window|kill-pane|quit)$/i.test(a))) {
    return { highRisk: base + ' can close terminal sessions the user has open', effective: { base, args } };
  }
  if (['docker', 'podman', 'nerdctl'].includes(base)) {
    const words = args.filter((a) => !String(a).startsWith('-'));
    const destructive = /^(stop|kill|rm|rmi|restart|down|prune|pause)$/i;
    const verb = ['compose', 'container', 'image', 'network', 'stack', 'service'].includes(words[0]) ? words[1] : words[0];
    if (destructive.test(verb || '') || (words[0] === 'volume' && /^(rm|prune)$/.test(words[1] || '')) || (words[0] === 'system' && words[1] === 'prune')) {
      return { highRisk: base + ' can stop or delete containers, images or volumes (and their data)', effective: { base, args } };
    }
  }
  if (base === 'kubectl' && args.some((a) => /^(delete|drain|cordon|scale|rollout|replace|apply|patch|edit)$/.test(a))) {
    return { highRisk: 'kubectl changes resources in a cluster', effective: { base, args } };
  }
  if (['kill', 'killall', 'pkill', 'systemctl', 'launchctl', 'service', 'crontab', 'at', 'iptables', 'ufw', 'netsh', 'reg', 'scp', 'rsync', 'ssh'].includes(base)) {
    return { highRisk: base + ' affects processes, services, or remote systems', effective: { base, args } };
  }
  if ((base === 'curl' || base === 'wget') && args.some((a) => /^(-o|-O|--output|--remote-name|-T|--upload-file|-d|--data|-F|--form|-X)$/.test(a) || /^--(data|form|upload)/.test(a))) {
    return { highRisk: base + ' writes files or sends data', effective: { base, args } };
  }
  return { effective: { base, args } };
}
