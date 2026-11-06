// Read-only commands that run without a permission prompt.
//
// Asking before `ls`, `git status` or `grep -rn foo src` costs the user a click
// for nothing and makes every task slower than it needs to be. Claude Code runs
// a fixed set of read-only commands without asking; this is OASIS's version,
// and it is deliberately narrower:
//
//   - Only programs that cannot write files or run other programs, and only
//     with the flags that keep them that way (find without -exec/-delete, sort
//     without -o, rg without --pre, git subcommands that only read).
//   - No sudo/env/xargs/timeout prefixes, no `FOO=bar` assignments, no `$`
//     expansion, no `~`, no command substitution, no redirection other than
//     `2>&1` and `>/dev/null`.
//   - Every path must stay inside the workspace (after resolving symlinks), and
//     secret files (.env, keys, .npmrc, .netrc) always ask.
//
// Everything else keeps the normal approval policy. Explicit ask/deny rules and
// PreToolUse hooks run before this and still win. Turn it off with
// OASIS_READ_ONLY_COMMANDS=0 or "permissions": { "readOnlyCommands": false }.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { splitShell } from './shell-risk.mjs';
import { resolvedRealPath } from './permissions.mjs';

const SIMPLE = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'stat', 'du', 'df', 'diff', 'cmp',
  'file', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'uname', 'id', 'true',
  'nproc', 'cut', 'tr', 'nl', 'column', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'jq', 'sort', 'uniq', 'find',
  'od', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'shasum', 'b2sum', 'cksum', 'type', 'cd'
]);

// Flags that make an otherwise read-only program write files or run code.
const UNSAFE_FLAGS = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o.*|--output(=.*)?|--compress-program(=.*)?)$/,
  rg: /^--pre(=.*)?$/,
  tree: /^(-o|-R|--fromfile)$/,
  file: /^(-C|--compile)$/,
  date: /^(-s.*|--set(=.*)?)$/
};

const VERSION_PROGRAMS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'pip', 'pip3', 'uv', 'go', 'cargo', 'rustc',
  'java', 'javac', 'ruby', 'gem', 'gcc', 'g++', 'clang', 'make', 'cmake', 'dotnet', 'php', 'perl', 'tsc', 'git', 'docker'
]);

const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'cat-file',
  'grep', 'merge-base', 'rev-list', 'name-rev', 'for-each-ref', 'count-objects', 'check-ignore', 'whatchanged'
]);
const GIT_UNSAFE_ARG = /^(--output(=.*)?|--ext-diff|--textconv|--open-files-in-pager.*|-O.*)$/;
const GIT_BRANCH_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '-l', '--show-current', '--no-color', '--color']);

const NPM_READ = new Set(['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'outdated', 'root', 'prefix', 'why', 'explain']);

const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|\.envrc|\.pgpass|\.my\.cnf|\.htpasswd|\.dockercfg|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;

const SECRET_DIR = /(^|\/)\.(ssh|aws|gnupg|azure|kube|docker)(\/|$)/i;
const secretRelative = (rel) => SECRET_FILE.test(rel) || SECRET_DIR.test(rel);

// Recursive searches read every file under a folder, so a `grep -r KEY .` would
// print .env or key files that a direct `cat .env` asks for. Before such a
// search runs without asking, the folder is walked (bounded) and the command
// asks if a secret file is there, if a followed symlink could leave the
// workspace, or if the folder is too big to check.
const WALK_LIMIT = 5000;
const WALK_SKIP = new Set(['node_modules', '.git']);

function treeHasSecret(dir, root, { hidden = true, followLinks = false } = {}) {
  const queue = [dir];
  let seen = 0;
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOTDIR' || error.code === 'ENOENT') { if (current === dir) return false; } return true; }
    for (const entry of entries) {
      if (++seen > WALK_LIMIT) return true;
      if (!hidden && entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (secretRelative(rel)) return true;
      if (entry.isSymbolicLink()) { if (followLinks) return true; continue; }
      if (entry.isDirectory() && !WALK_SKIP.has(entry.name)) queue.push(full);
    }
  }
  return false;
}

const shortFlag = (arg, letters) => /^-[A-Za-z0-9]+$/.test(arg) && [...letters].some((letter) => arg.slice(1).includes(letter));

// Returns null when the command does not search recursively, else what to check.
function recursiveRead(name, args) {
  const operands = args.filter((arg) => !arg.startsWith('-'));
  if (name === 'grep' || name === 'egrep' || name === 'fgrep') {
    const follow = args.some((arg) => arg === '--dereference-recursive' || shortFlag(arg, 'R'));
    const recursive = follow || args.some((arg) => arg === '--recursive' || arg === '--directories=recurse' || shortFlag(arg, 'r')) || args.some((arg, i) => arg === '-d' && args[i + 1] === 'recurse');
    if (!recursive) return null;
    const explicitPattern = args.some((arg) => arg === '-e' || arg === '-f' || arg.startsWith('--regexp') || arg.startsWith('--file'));
    return { paths: explicitPattern ? operands : operands.slice(1), hidden: true, followLinks: follow };
  }
  if (name === 'rg' || name === 'ag') {
    const hidden = args.some((arg) => /^--(hidden|no-ignore.*|unrestricted|all-types|skip-vcs-ignores)$/.test(arg) || /^-u+$/.test(arg) || (name === 'ag' && arg === '-a'));
    const followLinks = args.some((arg) => arg === '--follow' || arg === '-L' || (name === 'ag' && arg === '-f'));
    const explicitPattern = args.some((arg) => arg === '-e' || arg === '-f' || arg.startsWith('--regexp') || arg.startsWith('--file'));
    // rg/ag skip hidden files by default, but not every secret is hidden (key.pem).
    return { paths: explicitPattern ? operands : operands.slice(1), hidden, followLinks };
  }
  if (name === 'diff' && args.some((arg) => arg === '--recursive' || shortFlag(arg, 'r'))) return { paths: operands, hidden: true, followLinks: true };
  return null;
}

function recursiveReadSafe(name, args, cwd, root) {
  const plan = recursiveRead(name, args);
  if (!plan) return true;
  const targets = plan.paths.length ? plan.paths : ['.'];
  return !targets.some((target) => treeHasSecret(path.resolve(cwd, target), path.resolve(root), plan));
}

// `git show HEAD:.env` and `git cat-file -p HEAD:.env` read a committed secret.
const gitObjectSecret = (args) => args.some((arg) => { const at = arg.indexOf(':'); return at !== -1 && !arg.startsWith('-') && secretRelative(arg.slice(at + 1).replace(/^\.\//, '')); });

export function readOnlyCommandsEnabled(env = process.env, settings = {}) {
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_READ_ONLY_COMMANDS || ''))) return false;
  const permissions = settings && settings.permissions;
  return !(permissions && permissions.readOnlyCommands === false);
}

function insideWorkspace(token, cwd, root) {
  const value = String(token);
  if (value === '/dev/null' || value === '-') return true;
  if (value.startsWith('~')) return false;
  const absolute = path.resolve(cwd, value);
  const rel = path.relative(root, absolute);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
  if (secretRelative(rel.split(path.sep).join('/'))) return false;
  const real = resolvedRealPath(rel || '.', root);
  if (real) {
    const realRel = path.relative(real.root, real.path);
    if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) return false;
    if (secretRelative(realRel.split(path.sep).join('/'))) return false;
  }
  return true;
}

// Every argument that could name a file must stay in the workspace. Patterns
// such as `grep foo` are checked too; they resolve to a harmless path inside.
function argsStayInside(args, cwd, root) {
  for (const arg of args) {
    const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (!value || (arg.startsWith('-') && !arg.includes('='))) continue;
    if (!insideWorkspace(value, cwd, root)) return false;
  }
  return true;
}

// A repository's own config can name programs that "read-only" commands run:
// diff.external and textconv drivers (git diff/log -p/show/blame), clean and
// smudge filters (git status/diff/cat-file --filters) and a custom gpg
// program (signature display). A cloned or unpacked repository with such a
// .git/config would otherwise run them without asking. Only local/worktree
// scope counts; user and system settings (git-lfs filters) are the user's own.
const REPO_COMMAND_KEY = /^(?:diff\.external|diff\..+\.(?:textconv|command)|filter\..+\.(?:clean|smudge|process)|gpg\.(?:.+\.)?program)$/i;

function repoCommandKeys(cwd, env) {
  const result = spawnSync('git', ['config', '--show-scope', '--get-regexp', '^(diff|filter|gpg)\\.'], { cwd, env, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || (result.status !== 0 && result.status !== 1)) return null;
  const keys = [];
  for (const line of String(result.stdout || '').split('\n')) {
    const [scope, rest = ''] = line.split('\t');
    const key = rest.split(' ')[0];
    if ((scope === 'local' || scope === 'worktree') && REPO_COMMAND_KEY.test(key)) keys.push(key);
  }
  return keys;
}

export function repoConfigRunsCommands(cwd, env = process.env) {
  const keys = repoCommandKeys(cwd, env);
  return !keys || keys.length > 0;
}

/**
 * `-c key=` arguments that switch off the clean/smudge filter programs a
 * repository's own config defines, for git reads that must not run them.
 */
export function repoFilterOverrides(cwd, env = process.env) {
  const keys = repoCommandKeys(cwd, env) || [];
  return keys.filter((key) => /^filter\./i.test(key)).flatMap((key) => ['-c', key + '=']);
}

function readOnlyGit(args) {
  if (args[0] === '--no-pager') args = args.slice(1);
  const [sub, ...rest] = args;
  if (!sub) return false;
  if (rest.some((arg) => GIT_UNSAFE_ARG.test(arg))) return false;
  if (GIT_READ.has(sub)) return true;
  if (sub === 'branch') return rest.every((arg) => GIT_BRANCH_FLAGS.has(arg) || /^--(contains|merged|no-merged|sort|format)=/.test(arg));
  if (sub === 'tag') return rest.length === 0 || rest[0] === '-l' || rest[0] === '--list';
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')) || (rest[0] === 'get-url' && rest.length === 2);
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'reflog') return rest.length === 0 || rest[0] === 'show';
  if (sub === 'worktree') return rest[0] === 'list';
  if (sub === 'config') return ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(rest[0]) || (rest.length === 2 && rest[0] === '--global' && ['--list', '-l'].includes(rest[1]));
  return false;
}

/**
 * True when `command args` only reads, inside the workspace. `cwd` is where it
 * runs (a shell line may `cd` first); paths are resolved from there.
 */
export function readOnlyArgv(command, args = [], { root, cwd = root } = {}) {
  if (!root || typeof command !== 'string' || !command || command.includes('/') || command.includes('\\')) return false;
  const name = command.replace(/\.exe$/i, '').toLowerCase();
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return false;
  if (args.length === 1 && /^(--version|-v|-V|version)$/.test(args[0]) && VERSION_PROGRAMS.has(name)) return true;
  if (name === 'git') {
    if (!readOnlyGit(args) || gitObjectSecret(args)) return false;
    // git grep --untracked/--no-index and git diff --no-index read files Git does not track.
    if (args.some((arg) => arg === '--untracked' || arg === '--no-index')) return false;
    return argsStayInside(args.filter((arg) => !GIT_READ.has(arg)), cwd, root) && !repoConfigRunsCommands(cwd);
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') return NPM_READ.has(args[0]) && args.slice(1).every((arg) => !arg.startsWith('--prefix') && !arg.startsWith('-C')) && argsStayInside(args.slice(1), cwd, root);
  if (!SIMPLE.has(name) || name === 'cd') return false;
  const unsafe = UNSAFE_FLAGS[name];
  if (unsafe && args.some((arg) => unsafe.test(arg))) return false;
  if (name === 'uniq' && args.filter((arg) => !arg.startsWith('-')).length > 1) return false;
  return argsStayInside(args, cwd, root) && recursiveReadSafe(name, args, cwd, root);
}

/**
 * Environment for a git command run without asking: never take optional locks,
 * never start an fsmonitor hook or a pager from the repository's config.
 */
export function readOnlyGitEnv(env = process.env) {
  const out = { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat' };
  const count = Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0;
  out['GIT_CONFIG_KEY_' + count] = 'core.fsmonitor';
  out['GIT_CONFIG_VALUE_' + count] = 'false';
  out.GIT_CONFIG_COUNT = String(count + 1);
  return out;
}

const HARMLESS_REDIRECTS = /\s(?:2>&1|[12]?>\s*\/dev\/null)(?=\s|$|;|&&|\|)/g;

// Shell words of a line in the small grammar readOnlyShellLine accepts (no
// $, ~, braces, parentheses or redirects), split into simple commands on
// && || ; |. Each word records the glob the shell would expand: unquoted
// * ? [ stay wildcards, quoted or escaped ones are literal characters.
function globWords(text) {
  const commands = [];
  let words = [];
  let value = '';
  let pattern = '';
  let glob = false;
  let has = false;
  let quote = '';
  const push = () => { if (has) words.push({ value, pattern: glob ? pattern : null }); value = ''; pattern = ''; glob = false; has = false; };
  const literal = (ch) => { value += ch; pattern += /[*?[\]\\]/.test(ch) ? '\\' + ch : ch; has = true; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { literal(text[++i]); continue; }
      literal(ch);
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { literal(text[++i]); continue; }
    if (ch === '&' || ch === '|' || ch === ';') { push(); if (text[i + 1] === ch) i++; if (words.length) commands.push(words); words = []; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === '*' || ch === '?' || ch === '[') { value += ch; pattern += ch; glob = true; has = true; continue; }
    value += ch; pattern += ch; has = true;
  }
  push();
  if (words.length) commands.push(words);
  return commands;
}

// One path segment of a glob as a RegExp (bash defaults: no dotglob, so a
// leading * or ? does not match a leading dot; [!x] and [^x] negate).
function segmentRegExp(segment) {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '\\' && i + 1 < segment.length) { source += segment[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue; }
    if (ch === '*') { source += '[^/]*'; continue; }
    if (ch === '?') { source += '[^/]'; continue; }
    if (ch === '[') {
      const close = segment.indexOf(']', i + 2);
      if (close !== -1) {
        let body = segment.slice(i + 1, close);
        const negate = body[0] === '!' || body[0] === '^';
        if (negate) body = body.slice(1);
        source += '[' + (negate ? '^' : '') + body.replace(/\\/g, '\\\\').replace(/^\]/, '\\]') + ']';
        i = close;
        continue;
      }
      source += '\\[';
      continue;
    }
    source += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}

const hasWildcard = (segment) => /(^|[^\\])[*?[]/.test(segment);
const unescapeGlob = (segment) => segment.replace(/\\(.)/g, '$1');

// Expands one glob the way the shell would, relative to cwd, without leaving
// the workspace. Returns the matches (sorted, as bash does), [] when nothing
// matches, or null when the glob cannot be checked (absolute, too large, a
// symlinked folder outside the workspace, unreadable).
function expandGlob(pattern, cwd, root) {
  if (pattern.startsWith('/')) return null;
  const segments = pattern.split('/').filter((segment, index, all) => segment || index === all.length - 1);
  let current = [''];
  let examined = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    const next = [];
    for (const prefix of current) {
      const dir = path.resolve(cwd, prefix || '.');
      if (!hasWildcard(segment)) {
        const name = unescapeGlob(segment);
        next.push(prefix + name + (last ? '' : '/'));
        continue;
      }
      if (prefix && !insideWorkspace(dir, cwd, root)) return null;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; return null; }
      let matcher;
      try { matcher = segmentRegExp(segment); } catch { return null; }
      const dotOk = unescapeGlob(segment).startsWith('.');
      for (const entry of entries) {
        if (++examined > WALK_LIMIT) return null;
        if (entry.name.startsWith('.') && !dotOk) continue;
        if (!matcher.test(entry.name)) continue;
        if (!last && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        next.push(prefix + entry.name + (last ? '' : '/'));
      }
    }
    current = next.sort();
    if (!current.length) return [];
  }
  return current.map((item) => item.replace(/\/$/, ''));
}

/** True when every command in a shell line only reads, inside the workspace. */
export function readOnlyShellLine(line, { root } = {}) {
  if (!root) return false;
  const text = String(line || '').replace(HARMLESS_REDIRECTS, ' ');
  if (!text.trim() || /[`$<>~]|\(|\)|\{|\}|\n/.test(text)) return false;
  // `a & b` would leave a background process running.
  if (/(^|[^&])&([^&]|$)/.test(text)) return false;
  let cwd = path.resolve(root);
  const commands = splitShell(text);
  if (!commands.length) return false;
  // The shell expands unquoted globs after this check, so `cat .en?` would read
  // .env. Each glob is expanded here the same way and the matches are checked
  // like typed paths; a glob that cannot be expanded safely asks.
  const words = globWords(text);
  if (words.length !== commands.length || words.some((list, index) => list.length !== commands[index].tokens.length)) {
    if (words.some((list) => list.some((word) => word.pattern))) return false;
  }
  for (let index = 0; index < commands.length; index++) {
    let tokens = commands[index].tokens;
    const typed = words[index] || [];
    if (typed.some((word) => word.pattern)) {
      if (typed[0].pattern || tokens[0] === 'cd') return false;
      const expanded = [];
      for (const word of typed) {
        if (!word.pattern) { expanded.push(word.value); continue; }
        const matches = expandGlob(word.pattern, cwd, root);
        if (matches === null) return false;
        if (matches.length) expanded.push(...matches);
        else expanded.push(word.value);
      }
      tokens = expanded;
    }
    if (!tokens.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
    const [command, ...args] = tokens;
    if (command === 'cd') {
      if (args.length !== 1) return false;
      const next = path.resolve(cwd, args[0]);
      if (!insideWorkspace(next, cwd, root)) return false;
      cwd = next;
      continue;
    }
    if (!readOnlyArgv(command, args, { root: path.resolve(root), cwd })) return false;
  }
  return true;
}
