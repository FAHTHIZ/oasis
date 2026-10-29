// Tab completion for the interactive prompt: /commands (built-in, custom,
// skills, imported) and @file mentions with path and fuzzy matching.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { sensitivePath, walkFiles } from './tools.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv', 'target']);
const PRIMARY_SKILL_COMMANDS = ['init', 'plan', 'fix', 'diagnose', 'review', 'rollback'];

export function tokenAt(text, cursor) {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  return { start, end: cursor, token: text.slice(start, cursor) };
}

export function rankFuzzy(files, query, limit = 30) {
  const needle = query.toLowerCase();
  const scored = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score = -1;
    if (base.startsWith(needle)) score = 0;
    else if (base.includes(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    else {
      // Subsequence match ("srcli" → src/cli.mjs).
      let i = 0;
      for (const ch of lower) if (ch === needle[i]) i += 1;
      if (i === needle.length) score = 3;
    }
    if (score >= 0) scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((item) => item.file);
}

export function createCompleter({ root, commands = async () => [] }) {
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
