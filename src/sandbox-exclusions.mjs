// Claude Code's sandbox.excludedCommands: commands that run outside the OS sandbox.
// Each entry is the content of a Bash(...) permission rule ("docker *", "make build").
// A call leaves the sandbox only when every command in it matches an entry and it
// has none of the shapes that stay sandboxed: a command starting with sudo, eval or
// xargs; cd/pushd/popd anywhere; command substitution, subshells, braces or control
// flow; redirections other than fd duplication (2>&1); a command name from a variable
// or an assignment prefix; and git clone/init/worktree add/worktree move/bundle create
// with an absolute, ~ or .. path. Excluded commands still go through the normal
// permission flow (no sandbox auto-approval).
import { parseRule, ruleMatches } from './permissions.mjs';

const STAY_FIRST = new Set(['sudo', 'eval', 'xargs', 'cd', 'pushd', 'popd', 'exec', 'source', '.']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', '[[', ']]', '!', 'time', 'coproc']);

// Splits a shell line into commands (arrays of words) on unquoted && || ; | &.
// Returns null when the line has a shape that must stay sandboxed.
export function simpleShellCommands(line) {
  const text = String(line || '');
  if (!text.trim() || text.length > 20000) return null;
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endCommand = () => { endWord(); if (!words.length) return false; commands.push(words); words = []; return true; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = ''; else word += ch; continue; }
    if (quote === '"') {
      if (ch === '"') { quote = ''; continue; }
      if (ch === '`' || (ch === '$' && text[i + 1] === '(')) return null;
      if (ch === '\\' && i + 1 < text.length) { word += text[++i]; continue; }
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === '\\') { if (text[i + 1] === '\n') return null; word += text[++i] || ''; inWord = true; continue; }
    if (ch === '\n' || ch === '`' || ch === '(' || ch === ')' || ch === '{' || ch === '}') return null;
    if (ch === '$' && text[i + 1] === '(') return null;
    if (ch === '<' || ch === '>') {
      // Only fd duplication such as 2>&1 or >&2 is allowed.
      const dup = text.slice(i).match(/^[<>]&\d+/);
      if (!dup || (inWord && !/^\d+$/.test(word))) return null;
      word = ''; inWord = false;
      i += dup[0].length - 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === ';' || ch === '&' || ch === '|') {
      if (!endCommand()) return null;
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) i += 1;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote) return null;
  endWord();
  if (words.length) commands.push(words);
  return commands.length ? commands : null;
}

function riskyGitPath(words) {
  if (words[0] !== 'git') return false;
  const rest = words.slice(1).filter((item) => !item.startsWith('-'));
  const sub = rest[0];
  const action = (sub === 'worktree' || sub === 'bundle') ? sub + ' ' + rest[1] : sub;
  if (!['clone', 'init', 'worktree add', 'worktree move', 'bundle create'].includes(action)) return false;
  return words.slice(1).some((item) => item.startsWith('/') || item.startsWith('~') || /^[A-Za-z]:[\\/]/.test(item) || item.split(/[\\/]/).includes('..'));
}

function staysSandboxed(words) {
  const first = words[0] || '';
  if (STAY_FIRST.has(first) || KEYWORDS.has(first)) return true;
  if (first.includes('$') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return true;
  return riskyGitPath(words);
}

/** True when a shell line may run outside the sandbox under these excludedCommands entries. */
export function shellLineExcluded(line, entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  const commands = simpleShellCommands(line);
  if (!commands) return false;
  const rules = entries.map((entry) => parseRule('Bash(' + String(entry) + ')')).filter(Boolean);
  if (!rules.length) return false;
  return commands.every((words) => !staysSandboxed(words)
    && rules.some((rule) => ruleMatches(rule, 'run_shell', { command: words.map(quoteWord).join(' ') })));
}

/** The same check for run_command's program + arguments (no shell parsing involved). */
export function argvExcluded(command, args, entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  const words = [String(command || ''), ...(Array.isArray(args) ? args.map(String) : [])];
  if (!words[0] || staysSandboxed(words)) return false;
  const rules = entries.map((entry) => parseRule('Bash(' + String(entry) + ')')).filter(Boolean);
  return rules.some((rule) => ruleMatches(rule, 'run_shell', { command: words.map(quoteWord).join(' ') }));
}

function quoteWord(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
}
