// Tab completion for the interactive prompt: /commands (built-in, custom,
// skills, imported) and @file mentions with path and fuzzy matching.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import fuzzysort from 'fuzzysort';
import { sensitivePath, walkFiles } from './tools.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv', 'target']);
const PRIMARY_SKILL_COMMANDS = ['init', 'plan', 'fix', 'diagnose', 'review', 'rollback'];

function tokenAt(text, cursor) {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  return { start, end: cursor, token: text.slice(start, cursor) };
}

// Fuzzy path matching is fuzzysort (MIT, no dependencies): Sublime-style scoring
// that rewards contiguous runs and matches at word, path-segment and camelCase
// starts, so "srcli" finds src/cli.mjs and "cl doc" finds cli-doctor.mjs.
// Paths are prepared without fuzzysort's global cache, which would otherwise
// keep every path of every search alive.
const matchPath = (file, query) => fuzzysort.single(query, fuzzysort.prepare(String(file)));

/** The files matching query, best first (ties: shorter path, then alphabetical). */
export function rankFuzzy(files, query, limit = 30) {
  if (!String(query || '').trim()) return [];
  const scored = [];
  for (const file of files) {
    const hit = matchPath(file, query);
    if (hit) scored.push({ file, score: hit.score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((item) => item.file);
}

// Score one path for a query, higher is better (an integer, 1 to 10000), with
// the matched character positions for highlighting. null when it does not match.
export function fuzzyScore(file, query) {
  if (!String(query || '').trim()) return null;
  const hit = matchPath(file, query);
  if (!hit) return null;
  return { score: Math.max(1, Math.round(hit.score * 10000)), indices: [...hit.indexes].sort((a, b) => a - b) };
}

// Claude Code's fileSuggestion command: {"query"} on stdin, newline-separated paths on
// stdout, at most 15 shown, five-second limit. null means "use the built-in suggestion".
export async function suggestFilesWithCommand(setting, query, { root, env = process.env } = {}) {
  if (!setting || setting.type !== 'command' || !setting.command) return null;
  const { runHookCommand } = await import('./hooks.mjs');
  const result = await runHookCommand(setting.command, { query }, { root, env, timeout: 5 }).catch(() => null);
  if (!result || result.exitCode !== 0 || result.timedOut) return null;
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.replace(/[\x00-\x1f\x7f]/g, '').trim()).filter(Boolean).slice(0, 15);
}

export function createCompleter({ root, commands = async () => [], fileSuggestion = () => null, env = process.env }) {
  let fileCache = null;
  let fileCacheAt = 0;
  const projectFiles = async () => {
    if (!fileCache || Date.now() - fileCacheAt > 30000) {
      const files = await walkFiles(root, { maxFiles: 8000, maxDepth: 12 }).catch(() => []);
      fileCache = files.map((item) => item.relative.split(path.sep).join('/'));
      fileCacheAt = Date.now();
    }
    return fileCache;
  };

  const completeFile = async (token, start, end) => {
    const query = token.slice(1);
    const custom = await suggestFilesWithCommand(typeof fileSuggestion === 'function' ? fileSuggestion() : fileSuggestion, query, { root, env });
    if (custom) return { start, end, candidates: custom.map((file) => ({ value: '@' + file, display: '@' + file })) };
    const slash = query.lastIndexOf('/');
    const dirPart = slash >= 0 ? query.slice(0, slash + 1) : '';
    const base = slash >= 0 ? query.slice(slash + 1) : query;
    const candidates = [];
    const seen = new Set();
    const directory = path.resolve(root, dirPart || '.');
    const relativeDir = path.relative(path.resolve(root), directory);
    if (!relativeDir.startsWith('..') && !path.isAbsolute(relativeDir)) {
      let entries = [];
      try { entries = await readdir(directory, { withFileTypes: true }); } catch {}
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.name.toLowerCase().startsWith(base.toLowerCase())) continue;
        if (entry.name.startsWith('.') && !base.startsWith('.')) continue;
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name) && !base) continue;
        const rel = dirPart + entry.name + (entry.isDirectory() ? '/' : '');
        if (sensitivePath(rel.replace(/\/$/, ''))) continue;
        seen.add(rel);
        candidates.push({ value: '@' + rel, display: '@' + rel });
      }
    }
    if (base && !dirPart) {
      for (const file of rankFuzzy(await projectFiles(), base)) {
        if (seen.has(file)) continue;
        candidates.push({ value: '@' + file, display: '@' + file });
      }
    }
    return { start, end, candidates: candidates.slice(0, 60) };
  };

  return async function complete(text, cursor) {
    const { start, end, token } = tokenAt(text, cursor);
    if (token.startsWith('@')) return completeFile(token, start, end);
    // /connect gi<Tab> → apps from the connector catalog.
    if (/^\/(?:dis)?connect\s+$/i.test(text.slice(0, start)) && !token.startsWith('/')) {
      const { CONNECTOR_CATALOG } = await import('./connectors.mjs');
      const needle = token.toLowerCase();
      const candidates = CONNECTOR_CATALOG.filter((item) => item.id.startsWith(needle) || item.name.toLowerCase().startsWith(needle))
        .map((item) => ({ value: item.id, display: item.id, description: item.name + ' · ' + item.description }));
      return { start, end, candidates };
    }
    if (token.startsWith('/') && !text.slice(0, start).trim()) {
      const needle = token.slice(1).toLowerCase();
      const list = await commands();
      const seen = new Set();
      const candidates = [];
      for (const item of list) {
        const name = String(item.name || '').toLowerCase();
        if (!name || seen.has(name) || !name.startsWith(needle)) continue;
        seen.add(name);
        candidates.push({ value: '/' + name, display: '/' + name, description: item.description || '' });
      }
      candidates.sort((a, b) => {
        if (!needle) {
          const ai = PRIMARY_SKILL_COMMANDS.indexOf(a.value.slice(1));
          const bi = PRIMARY_SKILL_COMMANDS.indexOf(b.value.slice(1));
          if (ai !== bi) return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
        }
        return a.value.length - b.value.length || a.value.localeCompare(b.value);
      });
      return { start, end, candidates };
    }
    return null;
  };
}
