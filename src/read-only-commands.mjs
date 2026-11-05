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

const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;

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
  if (SECRET_FILE.test(rel.split(path.sep).join('/'))) return false;
  const real = resolvedRealPath(rel || '.', root);
  if (real) {
    const realRel = path.relative(real.root, real.path);
    if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) return false;
    if (SECRET_FILE.test(realRel.split(path.sep).join('/'))) return false;
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
  if (name === 'git') return readOnlyGit(args) && argsStayInside(args.filter((arg) => !GIT_READ.has(arg)), cwd, root);
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') return NPM_READ.has(args[0]) && args.slice(1).every((arg) => !arg.startsWith('--prefix') && !arg.startsWith('-C')) && argsStayInside(args.slice(1), cwd, root);
  if (!SIMPLE.has(name) || name === 'cd') return false;
  const unsafe = UNSAFE_FLAGS[name];
  if (unsafe && args.some((arg) => unsafe.test(arg))) return false;
  if (name === 'uniq' && args.filter((arg) => !arg.startsWith('-')).length > 1) return false;
  return argsStayInside(args, cwd, root);
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
  for (const { tokens } of commands) {
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
