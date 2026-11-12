// Agent ignore files from other coding tools, honoured by OASIS's file tools:
//   .cursorignore   Cursor          https://cursor.com/docs/context/ignore-files
//   .devinignore    Devin Desktop   (and the legacy Windsurf .codeiumignore, plus
//   .codeiumignore  Windsurf         the global ~/.codeium/.codeiumignore)
//   .geminiignore   Gemini CLI
//   .aiexclude      Gemini Code Assist
//   .aiderignore    Aider
// All use .gitignore syntax. A matching path is refused by read, write, edit and
// delete tools and left out of listings, glob, grep and search results and @
// mentions. Like Cursor, this cannot stop a shell command from reading a file.
//
// Files are looked for in the path's folder and every folder above it up to the
// git root (or, outside a repository, up to the folder below your home folder),
// so a repository's root file covers everything in it and a sub-folder can add
// its own. Each file is matched on its own: a "!" line re-includes paths only
// for the file it is in. OASIS_AGENT_IGNORE=0 turns the feature off.
//
// Pattern matching is node-ignore (MIT, https://github.com/kaelzhang/node-ignore),
// the .gitignore implementation ESLint and Prettier use, which follows git's own
// rules (checked against `git check-ignore` in test/agent-ignore.test.mjs).
import ignore from 'ignore';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const AGENT_IGNORE_FILES = [
  { name: '.cursorignore', tool: 'Cursor' },
  { name: '.devinignore', tool: 'Devin Desktop' },
  { name: '.codeiumignore', tool: 'Windsurf' },
  { name: '.geminiignore', tool: 'Gemini CLI' },
  { name: '.aiexclude', tool: 'Gemini Code Assist' },
  { name: '.aiderignore', tool: 'Aider' }
];
const MAX_IGNORE_FILE = 256 * 1024;
const MAX_RULES = 2000;
const CACHE_MS = 1500;

export function agentIgnoreEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.OASIS_AGENT_IGNORE || '').trim());
}

const isPattern = (line) => { const text = line.replace(/\r$/, '').trim(); return Boolean(text) && !text.startsWith('#'); };

/** The rules of one ignore file: { length, patterns, matcher }. At most 2,000 pattern lines are read. */
export function parseIgnoreFile(text) {
  const patterns = String(text || '').split('\n').map((line) => line.replace(/\r$/, '')).filter(isPattern).slice(0, MAX_RULES);
  return { length: patterns.length, patterns, matcher: ignore({ allowRelativePaths: false }).add(patterns) };
}

// .gitignore semantics: the last matching line wins, and a path inside an
// ignored folder stays ignored (a "!" line cannot re-include it). Returns
// { pattern } for the line that excludes the path, or null.
export function ignoredByRules(rules, relativePath, isDir = false) {
  const relative = String(relativePath || '').split('/').filter(Boolean).join('/');
  if (!relative || !rules || !rules.length) return null;
  let result;
  try { result = rules.matcher.test(isDir ? relative + '/' : relative); } catch { return null; }
  return result.ignored ? { pattern: String(result.rule?.pattern ?? '').trim() } : null;
}

const dirCache = new Map();
const globalCache = { at: 0, key: '', rules: [] };

async function exists(file) {
  try { await lstat(file); return true; } catch { return false; }
}

async function readRules(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_IGNORE_FILE) return null;
    return parseIgnoreFile(await readFile(file, 'utf8'));
  } catch { return null; }
}

async function directoryInfo(dir) {
  const cached = dirCache.get(dir);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const files = [];
  for (const spec of AGENT_IGNORE_FILES) {
    const file = path.join(dir, spec.name);
    const rules = await readRules(file);
    if (rules && rules.length) files.push({ file, tool: spec.tool, rules });
  }
  const value = { files, git: await exists(path.join(dir, '.git')) };
  if (dirCache.size > 5000) dirCache.clear();
  dirCache.set(dir, { at: Date.now(), value });
  return value;
}

async function globalRules(env, home) {
  const file = path.join(home, '.codeium', '.codeiumignore');
  if (globalCache.key === file && Date.now() - globalCache.at < CACHE_MS) return globalCache.rules;
  const rules = (await readRules(file)) || [];
  Object.assign(globalCache, { at: Date.now(), key: file, rules: rules.length ? [{ file, tool: 'Windsurf (global)', rules }] : [] });
  return globalCache.rules;
}

// The folders whose ignore files apply to dir, nearest first, and the top one.
async function scopesFor(dir, home) {
  const scopes = [];
  let top = dir;
  for (let current = dir, i = 0; i < 40; i++) {
    if (current === home || current === path.parse(current).root) break;
    const info = await directoryInfo(current);
    for (const item of info.files) scopes.push({ ...item, dir: current });
    top = current;
    if (info.git) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { scopes, top };
}

/**
 * Which agent ignore file excludes absolutePath, as { file, tool, pattern }, or null.
 * options.isDir says the path is a folder (for patterns ending in "/").
 */
export async function agentIgnoreMatch(absolutePath, options = {}) {
  const env = options.env || process.env;
  if (!agentIgnoreEnabled(env)) return null;
  const target = path.resolve(String(absolutePath || ''));
  const home = path.resolve(options.home || env.HOME || os.homedir());
  const { scopes, top } = await scopesFor(path.dirname(target), home);
  const all = [...scopes, ...(await globalRules(env, home)).map((item) => ({ ...item, dir: top }))];
  for (const scope of all) {
    const relative = path.relative(scope.dir, target).split(path.sep).join('/');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const rule = ignoredByRules(scope.rules, relative, Boolean(options.isDir));
    if (rule) return { file: scope.file, tool: scope.tool, pattern: rule.pattern };
  }
  return null;
}

export function agentIgnoreMessage(match, shown) {
  return (shown ? shown + ' is' : 'That path is') + ' excluded by ' + path.basename(match.file) + ' (' + match.tool + ' ignore file, pattern "' + match.pattern + '"). OASIS will not read, change or list it; edit ' + path.basename(match.file) + ' if this should change.';
}

/** Throws when an agent ignore file excludes absolutePath. */
export async function assertNotAgentIgnored(absolutePath, options = {}) {
  const match = await agentIgnoreMatch(absolutePath, options);
  if (match) {
    const error = new Error(agentIgnoreMessage(match, options.shown));
    error.code = 'OASIS_AGENT_IGNORED';
    throw error;
  }
}

/** Keeps the items whose absolute path (getPath(item)) no ignore file excludes. */
export async function filterAgentIgnored(items, getPath = (item) => item, options = {}) {
  const env = options.env || process.env;
  if (!agentIgnoreEnabled(env) || !items.length) return items;
  const kept = [];
  for (const item of items) {
    if (!(await agentIgnoreMatch(getPath(item), { env, home: options.home }))) kept.push(item);
  }
  return kept;
}
