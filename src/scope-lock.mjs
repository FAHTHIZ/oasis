// Scope lock: confine file-changing tools to the paths the user named.
// A top complaint about coding agents is "it edited files I never asked it to
// touch". /scope src/parser/** test/parser/** (or OASIS_EDIT_SCOPE) makes any
// edit, write, delete, or notebook change outside those paths fail with a
// clear message telling the agent to ask the user instead.

import path from 'node:path';
import { globToRegExp } from './permissions.mjs';

export const SCOPED_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'delete_file']);

function normalizePattern(raw) {
  let value = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value) return '';
  if (value === '.' || value === '/') return '**';
  if (!/[*?]/.test(value)) value = value.replace(/\/+$/, '');
  return value;
}

function compile(pattern) {
  if (/[*?]/.test(pattern)) return [globToRegExp(pattern)];
  // A plain path means that file, or everything under that directory.
  return [globToRegExp(pattern), globToRegExp(pattern + '/**')];
}

export function setEditScope(session, patterns) {
  const list = [...new Set((Array.isArray(patterns) ? patterns : String(patterns || '').split(/[\s,]+/)).map(normalizePattern).filter(Boolean))];
  if (!list.length) { delete session.editScope; return []; }
  Object.defineProperty(session, 'editScope', { value: { patterns: list, matchers: list.flatMap(compile) }, writable: true, configurable: true, enumerable: false });
  return list;
}

export function clearEditScope(session) { delete session.editScope; }

export function editScopeFromEnv(session, env = process.env) {
  if (env.OASIS_EDIT_SCOPE && !session.editScope) setEditScope(session, env.OASIS_EDIT_SCOPE);
}

/** Returns an error message when the tool call would change a file outside scope. */
export function scopeViolation(session, toolName, args) {
  const scope = session && session.editScope;
  if (!scope || !SCOPED_TOOLS.has(toolName) || !args || typeof args.path !== 'string') return '';
  const root = path.resolve(session.root || process.cwd());
  const relative = path.relative(root, path.resolve(root, args.path)).split(path.sep).join('/');
  if (scope.matchers.some((matcher) => matcher.test(relative))) return '';
  return 'Scope lock: ' + toolName + ' on "' + relative + '" is outside the paths the user allowed for this session (' + scope.patterns.join(', ') + '). ' +
    'Do not work around this with shell commands. If changing this file is genuinely required, stop and ask the user, explaining why.';
}
