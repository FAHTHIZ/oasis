// Repository map: a compact, ranked outline of the files and top-level symbols in
// a workspace, so a model can orient itself without reading many whole files.
// Inspired by Aider's repo map, but dependency-free: definitions are found with
// per-language line patterns (no tree-sitter) and files are ranked by how often
// other files reference the symbols they define, plus a boost for anything the
// caller says it is focused on.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { walkFiles } from './tools.mjs';

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 1536 * 1024;
const DEFAULT_MAX_CHARS = 12000;
const MAX_DEFS_PER_FILE = 400;
const MAX_SHOWN_PER_FILE = 40;

// Each language lists line patterns; group 1 must be the defined name.
const JS = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s{2,4}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/
];
const LANGUAGES = {
  js: JS,
  py: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/, /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/],
  java: [/^\s*(?:public|protected|private|internal|abstract|final|sealed|static|open|data|\s)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/, /^\s+(?:public|protected|private|internal)\s+(?:static\s+)?(?:final\s+)?(?:async\s+)?(?:override\s+)?[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/, /^\s*(?:override\s+)?(?:suspend\s+)?fun\s+(?:[\w.<>]+\.)?([A-Za-z_]\w*)/],
  rb: [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, /^\s*(?:class|module)\s+([A-Z]\w*)/],
  php: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, /^\s*(?:public\s+|protected\s+|private\s+|static\s+)*function\s+([A-Za-z_]\w*)/],
  c: [/^(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][\w\s\*:<>,]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, /^\s*(?:typedef\s+)?(?:struct|class|enum|union|namespace)\s+([A-Za-z_]\w*)/],
  swift: [/^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+)?(?:final\s+)?(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/, /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?(?:static\s+)?func\s+([A-Za-z_]\w*)/],
  ex: [/^\s*defmodule\s+([A-Z][\w.]*)/, /^\s*defp?\s+([a-z_]\w*[?!]?)/],
  lua: [/^\s*(?:local\s+)?function\s+([\w.:]+)/],
  sh: [/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/]
};
const EXTENSIONS = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js', '.vue': 'js', '.svelte': 'js',
  '.py': 'py', '.pyi': 'py', '.go': 'go', '.rs': 'rs',
  '.java': 'java', '.kt': 'java', '.kts': 'java', '.scala': 'java', '.cs': 'java', '.dart': 'java',
  '.rb': 'rb', '.php': 'php', '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.cxx': 'c', '.hpp': 'c', '.hh': 'c', '.m': 'c',
  '.swift': 'swift', '.ex': 'ex', '.exs': 'ex', '.lua': 'lua', '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh'
};
const C_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'else', 'do', 'case', 'new', 'delete', 'throw', 'elif', 'when', 'match', 'constructor', 'function', 'super', 'require']);
const COMMON_NAMES = new Set(['main', 'init', 'run', 'get', 'set', 'test', 'setup', 'index', 'default', 'handler', 'start', 'stop', 'load', 'render', 'toString', 'call', 'apply', 'then', 'value', 'name', 'data', 'type', 'self', 'this', 'new', 'Error']);

const cache = new Map();

export function languageForFile(file) {
  return EXTENSIONS[path.extname(String(file)).toLowerCase()] || null;
}

export function extractDefinitions(text, language) {
  const patterns = LANGUAGES[language];
  if (!patterns) return [];
  const defs = [];
  const seen = new Set();
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length && defs.length < MAX_DEFS_PER_FILE; i++) {
    const line = lines[i];
    if (line.length > 400 || /^\s*(?:\/\/|#(?!\[)|\*|\/\*|--)/.test(line)) continue;
    for (let p = 0; p < patterns.length; p++) {
      const pattern = patterns[p];
      const match = pattern.exec(line);
      if (!match || !match[1]) continue;
      const name = match[1];
      if (C_KEYWORDS.has(name) || name.length < 2) break;
      const key = name + ':' + line.trim().slice(0, 60);
      if (seen.has(key)) break;
      seen.add(key);
      let signature = line.trim().replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ');
      if (signature.length > 140) signature = signature.slice(0, 137) + '...';
      defs.push({ name, line: i + 1, signature, member: /^\s/.test(line) });
      break;
    }
  }
  return defs;
}

function identifierCounts(text) {
  const counts = new Map();
  const matches = String(text).match(/[A-Za-z_$][\w$]{2,}/g) || [];
  for (const word of matches) counts.set(word, (counts.get(word) || 0) + 1);
  return counts;
}

async function scanFile(file) {
  const info = await stat(file.absolute).catch(() => null);
  if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) return null;
  const key = file.absolute + ':' + info.mtimeMs + ':' + info.size;
  const cached = cache.get(file.absolute);
  if (cached && cached.key === key) return cached.value;
  let text;
  try { text = await readFile(file.absolute, 'utf8'); } catch { return null; }
  if (text.includes('\0')) return null;
  const language = languageForFile(file.relative);
  const value = { defs: extractDefinitions(text, language), identifiers: identifierCounts(text), lines: text.split('\n').length };
  cache.set(file.absolute, { key, value });
  if (cache.size > 20000) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * Build a ranked repository map.
 * @param {string} root workspace root
 * @param {{ path?: string, focus?: string[]|string, maxChars?: number, maxFiles?: number }} options
 */
export async function buildRepoMap(root, options = {}) {
  const base = path.resolve(root, options.path || '.');
  const relBase = path.relative(path.resolve(root), base);
  if (relBase.startsWith('..') || path.isAbsolute(relBase)) throw new Error('repo_map path must stay inside the workspace.');
  const maxChars = Math.max(1000, Math.min(60000, Number.parseInt(options.maxChars, 10) || DEFAULT_MAX_CHARS));
  const focusTerms = (Array.isArray(options.focus) ? options.focus : String(options.focus || '').split(/[\s,]+/))
    .map((item) => String(item || '').trim()).filter(Boolean).slice(0, 40);
  const walked = await walkFiles(base, { maxFiles: Math.min(MAX_FILES, options.maxFiles || MAX_FILES), maxDepth: 12 });
  const files = [];
  for (const item of walked) {
    const relative = path.relative(path.resolve(root), item.absolute).split(path.sep).join('/');
    if (!languageForFile(relative)) continue;
    const scanned = await scanFile(item);
    if (scanned) files.push({ path: relative, ...scanned });
  }
  // Where each symbol is defined, and how many *other* files mention it.
  const definedIn = new Map();
  for (const file of files) for (const def of file.defs) {
    if (!definedIn.has(def.name)) definedIn.set(def.name, new Set());
    definedIn.get(def.name).add(file.path);
  }
  const refFiles = new Map();
  for (const file of files) for (const [word] of file.identifiers) {
    const owners = definedIn.get(word);
    if (!owners || (owners.size === 1 && owners.has(file.path))) continue;
    refFiles.set(word, (refFiles.get(word) || 0) + 1);
  }
  const focusFiles = focusTerms.filter((term) => term.includes('/') || term.includes('.')).map((term) => term.replace(/^\.\//, ''));
  const focusSymbols = new Set(focusTerms.filter((term) => !term.includes('/')));
  for (const file of files) {
    const defScores = [];
    for (const def of file.defs) {
      const refs = refFiles.get(def.name) || 0;
      const weight = COMMON_NAMES.has(def.name) || def.name.startsWith('_') ? 0.2 : def.member ? 0.35 : 1;
      def.refs = refs;
      def.score = weight * Math.log2(1 + refs) + (focusSymbols.has(def.name) ? 25 : 0) + (/^\s*(?:export|pub\b|public\b)/.test(def.signature) ? 0.5 : 0);
      defScores.push(def.score);
    }
    // Rank by a file's strongest definitions, not their count, so huge files
    // do not crowd out small central modules.
    let score = defScores.sort((a, b) => b - a).slice(0, 8).reduce((sum, value) => sum + value, 0);
    if (focusFiles.some((term) => file.path === term || file.path.endsWith('/' + term) || file.path.startsWith(term.replace(/\/$/, '') + '/'))) score += 50;
    for (const symbol of focusSymbols) if (file.identifiers.has(symbol)) score += 2;
    if (/(^|\/)(test|tests|__tests__|spec|fixtures?|snapshots?|__snapshots__|vendor|third_party|examples?)\//.test(file.path) || /\.(test|spec)\.[a-z]+$/.test(file.path)) score *= 0.4;
    file.score = score + Math.min(1, file.defs.length / 20);
  }
  files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const perFile = maxChars >= 30000 ? MAX_SHOWN_PER_FILE : maxChars >= 12000 ? 14 : 8;
  let output = '';
  let shownFiles = 0;
  let shownSymbols = 0;
  const omitted = [];
  for (const file of files) {
    const keep = new Set([...file.defs].sort((a, b) => b.score - a.score || a.line - b.line).slice(0, perFile));
    const defs = file.defs.filter((def) => keep.has(def));
    let block = file.path + (file.defs.length ? '' : ' (no top-level definitions found)') + '\n';
    for (const def of defs) block += '  ' + String(def.line).padStart(4) + '│ ' + def.signature + '\n';
    if (file.defs.length > defs.length) block += '        … ' + (file.defs.length - defs.length) + ' more definition(s)\n';
    if (output.length + block.length > maxChars) {
      // Fall back to a header-only line so the model still learns the file exists.
      const header = file.path + ' (' + file.defs.length + ' definitions, ' + file.lines + ' lines)\n';
      if (output.length + header.length <= maxChars) { output += header; shownFiles++; }
      else omitted.push(file.path);
      continue;
    }
    output += block;
    shownFiles++;
    shownSymbols += defs.length;
  }
  return {
    root: relBase || '.',
    files: files.length,
    shownFiles,
    symbols: shownSymbols,
    omittedFiles: omitted.length,
    map: output.trimEnd() || '(no source files with a known language were found)',
    hint: omitted.length
      ? omitted.length + ' lower-ranked file(s) omitted to fit the ' + maxChars + '-character budget. Pass path=<dir>, focus=[files or symbols] or a larger max_chars to see them.'
      : 'Files are ranked by how often other files reference their symbols. Use read_file with a line offset to open a definition.'
  };
}
