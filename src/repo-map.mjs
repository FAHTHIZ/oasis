// Repository map: a compact, ranked outline of the files and top-level symbols in
// a workspace, so a model can orient itself without reading many whole files.
// Inspired by Aider's repo map, but dependency-free: definitions are found with
// per-language line patterns (no tree-sitter) and files are ranked with
// personalized PageRank over the "uses a symbol defined in" graph, so central
// modules come first and, with a focus, the files around it rise with it.
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

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|fixtures?|__snapshots__)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;

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

// Identifiers used directly, not as property names (assert.deepEqual is not a use of deepEqual).
function bareIdentifierCounts(text) {
  const counts = new Map();
  for (const match of String(text).matchAll(/(?<![.\w$])[A-Za-z_$][\w$]{2,}/g)) counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  return counts;
}

// Module specifiers a file imports (JS/TS and Python), resolved later against the file list.
function importSpecifiers(text, language) {
  const out = new Set();
  if (language === 'js') {
    for (const m of String(text).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bexport\s*\*\s*from\s*)['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  } else if (language === 'py') {
    for (const m of String(text).matchAll(/^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import[ \t]+([\w, \t*()]+)|import[ \t]+([\w.]+))/gm)) {
      if (m[1]) {
        out.add(m[1]);
        // from . import a, b -> the sibling modules a and b
        if (/^\.+$/.test(m[1])) for (const name of m[2].replace(/[()]/g, '').split(',')) if (name.trim() && name.trim() !== '*') out.add(m[1] + name.trim().split(/\s+/)[0]);
      } else out.add(m[3]);
    }
  }
  return [...out].slice(0, 400);
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
  const value = { defs: extractDefinitions(text, language), identifiers: identifierCounts(text), refs: bareIdentifierCounts(text), imports: importSpecifiers(text, language), commonjs: language === 'js' && /\bmodule\.exports\b|\bexports\.[A-Za-z_$][\w$]*\s*=/.test(text), lines: text.split('\n').length };
  cache.set(file.absolute, { key, value });
  if (cache.size > 20000) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * Personalized PageRank over "file A uses a symbol defined in file B" edges
 * (the approach Aider's repo map popularised). Edge weight grows with how
 * often A mentions the symbol (sqrt, so one noisy file cannot dominate) and
 * shrinks for common names and for names defined in many files. Teleport
 * mass goes to focus files and files mentioning focus symbols when given.
 * Returns ranks scaled so the top file is 1, plus per-definition ranks.
 */
const JS_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

/** Resolve a file's import specifiers to indexes of files in the map (relative JS/TS and Python modules). */
function resolveImports(file, index, pythonModules) {
  const found = new Set();
  const language = languageForFile(file.path);
  const dir = path.posix.dirname(file.path);
  for (const spec of file.imports || []) {
    if (language === 'js') {
      if (!spec.startsWith('.')) continue;
      const joined = path.posix.normalize(path.posix.join(dir, spec));
      const stem = joined.replace(/\.(js|mjs|cjs|jsx)$/, '');
      for (const candidate of [...JS_SUFFIXES.map((suffix) => joined + suffix), ...JS_SUFFIXES.slice(1, 4).map((suffix) => stem + suffix)]) {
        if (index.has(candidate)) { found.add(index.get(candidate)); break; }
      }
    } else if (language === 'py') {
      let modulePath;
      if (spec.startsWith('.')) {
        const dots = spec.match(/^\.+/)[0].length;
        let base = dir;
        for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
        modulePath = path.posix.join(base, spec.slice(dots).replace(/\./g, '/'));
      } else modulePath = spec.replace(/\./g, '/');
      for (const candidate of [modulePath + '.py', modulePath + '/__init__.py']) {
        if (index.has(candidate)) { found.add(index.get(candidate)); break; }
        const suffix = pythonModules.get(candidate); // src/pkg/mod.py for "pkg.mod"
        if (suffix !== undefined) { found.add(suffix); break; }
      }
    }
  }
  found.delete(index.get(file.path));
  return found;
}

export function rankGraph(files, definedIn, { isFocusFile = () => false, focusSymbols = new Set(), iterations = 40, damping = 0.85 } = {}) {
  const index = new Map(files.map((file, i) => [file.path, i]));
  const n = files.length;
  // Only names another file can actually import take part. In an ES module that
  // uses export, unexported top-level names are local; in Go, lower-case names are.
  const linkable = new Map();
  const esmFiles = new Set();
  for (const [i, file] of files.entries()) if (languageForFile(file.path) === 'js' && file.defs.some((def) => /^\s*export\b/.test(def.signature))) esmFiles.add(i);
  for (const file of files) {
    const language = languageForFile(file.path);
    const esm = language === 'js' && file.defs.some((def) => /^\s*export\b/.test(def.signature));
    if (TEST_PATH.test(file.path)) continue; // test helpers are not imported by anything
    // A JS file that neither exports nor assigns module.exports is a script: nothing imports its names.
    if (language === 'js' && !esm && !file.commonjs) continue;
    for (const def of file.defs) {
      if (esm && !/^\s*export\b/.test(def.signature) && !def.member) continue;
      if (language === 'go' && !def.member && /^[a-z_]/.test(def.name)) continue;
      if (!linkable.has(def.name)) linkable.set(def.name, new Set());
      linkable.get(def.name).add(file.path);
    }
  }
  // Like Aider: compound identifiers (camelCase, snake_case, 8+ characters) are
  // far more telling than short plain words such as diff or join.
  // Python files under src/ or lib/ are importable by their package path.
  const pythonModules = new Map();
  files.forEach((file, i) => { const m = file.path.match(/^(?:src|lib|python)\/(.+\.py)$/); if (m) pythonModules.set(m[1], i); });
  const imported = files.map((file) => resolveImports(file, index, pythonModules));
  const nameWeight = (word) => COMMON_NAMES.has(word) || word.startsWith('_') ? 0.1 : (/[a-z][A-Z]|[a-zA-Z]_[a-zA-Z]/.test(word) && word.length >= 8) ? 10 : word.length < 4 ? 0.3 : 1;
  const out = Array.from({ length: n }, () => new Map()); // src -> dst -> weight
  const via = new Map(); // dst \0 symbol -> [[src, weight, strong]]
  const strong = Array.from({ length: n }, () => new Set()); // src -> dsts it really uses
  for (let i = 0; i < n; i++) {
    const file = files[i];
    const language = languageForFile(file.path);
    // A module that imports anything says where its names come from: a name it
    // uses from a file it does not import is almost always a coincidence.
    const explicit = (language === 'js' || language === 'py') && imported[i].size > 0;
    for (const j of imported[i]) { out[i].set(j, (out[i].get(j) || 0) + 2); strong[i].add(j); }
    for (const [word, count] of file.refs || file.identifiers) {
      const owners = linkable.get(word);
      if (!owners) continue;
      const others = [...owners].filter((owner) => owner !== file.path);
      if (!others.length) continue;
      const base = nameWeight(word) * (focusSymbols.has(word) ? 10 : 1) * Math.sqrt(Number(count) || 1) / (owners.size > 5 ? owners.size : Math.sqrt(owners.size)) / others.length;
      for (const owner of others) {
        const j = index.get(owner);
        // Same-language use without an import: impossible for an ES module that
        // exports (the name must be a coincidence), unlikely when the user
        // imports other things.
        const ownerExports = esmFiles.has(j);
        const sameLanguage = languageForFile(owner) === language;
        // JS (ESM or CommonJS) can only use another file's names through import/require.
        const weight = imported[i].has(j) ? base * 2 : !sameLanguage ? base * 0.05 : language === 'js' || explicit || ownerExports ? base * 0.02 : base;
        if (!weight) continue;
        out[i].set(j, (out[i].get(j) || 0) + weight);
        const key = owner + '\0' + word;
        if (!via.has(key)) via.set(key, []);
        via.get(key).push([i, weight, weight >= base]);
        if (weight >= base) strong[i].add(j);
      }
    }
  }
  // Weaker reverse links: when you focus on a module, the files that use it
  // (the callers you may need to update) should rise too, not only its dependencies.
  for (let i = 0; i < n; i++) for (const j of strong[i]) out[j].set(i, (out[j].get(i) || 0) + 0.25 * (out[i].get(j) || 0));
  const personal = new Float64Array(n);
  let personalTotal = 0;
  for (let i = 0; i < n; i++) {
    const file = files[i];
    const weight = (isFocusFile(file) ? 1 : 0) + ([...focusSymbols].some((symbol) => file.identifiers.has(symbol)) ? 0.5 : 0);
    personal[i] = weight;
    personalTotal += weight;
  }
  if (personalTotal === 0) {
    // No focus: start everywhere, but tests count less (they import a lot and are imported by nothing).
    for (let i = 0; i < n; i++) personal[i] = TEST_PATH.test(files[i].path) ? 0.05 : 1;
    personalTotal = personal.reduce((sum, value) => sum + value, 0);
  }
  for (let i = 0; i < n; i++) personal[i] /= personalTotal;
  const outTotal = out.map((edges) => [...edges.values()].reduce((sum, value) => sum + value, 0));
  let rank = Float64Array.from(personal);
  for (let step = 0; step < iterations && n; step++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!outTotal[i]) { dangling += rank[i]; continue; }
      for (const [j, weight] of out[i]) next[j] += damping * rank[i] * weight / outTotal[i];
    }
    for (let i = 0; i < n; i++) next[i] += (1 - damping + damping * dangling) * personal[i];
    rank = next;
  }
  // Small isolated clusters (a 2-file tool, a demo script) trap PageRank in
  // their sink, so a file's rank is scaled by how many distinct files use it.
  const users = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (const j of strong[i]) users[j]++;
  const maxUsers = Math.max(1, ...users);
  const blended = Array.from(rank, (value, i) => Math.sqrt(value) * (0.1 + 0.9 * Math.log2(1 + users[i]) / Math.log2(1 + maxUsers)));
  const top = Math.max(0, ...blended);
  const fileRank = new Map(files.map((file, i) => [file.path, top ? blended[i] / top : 0]));
  // A definition's rank is the share of PageRank flowing to it through its name.
  const symbolRaw = new Map();
  for (const [key, sources] of via) symbolRaw.set(key, sources.reduce((sum, [i, weight]) => sum + rank[i] * weight / (outTotal[i] || 1), 0));
  const topSymbol = Math.max(0, ...symbolRaw.values());
  const symbolRank = new Map([...symbolRaw].map(([key, value]) => [key, topSymbol ? value / topSymbol : 0]));
  // Distinct files that really use each definition (after the import rules above).
  const refCount = new Map([...via].map(([key, sources]) => [key, new Set(sources.filter(([, , real]) => real).map(([i]) => i)).size]));
  return { fileRank, symbolRank, refCount };
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
  const isFocusFile = (file) => focusFiles.some((term) => file.path === term || file.path.endsWith('/' + term) || file.path.startsWith(term.replace(/\/$/, '') + '/'));
  const { fileRank, symbolRank, refCount } = rankGraph(files, definedIn, { isFocusFile, focusSymbols });
  for (const file of files) {
    const defScores = [];
    for (const def of file.defs) {
      const refs = refCount.get(file.path + '\0' + def.name) || 0;
      const weight = COMMON_NAMES.has(def.name) || def.name.startsWith('_') ? 0.2 : def.member ? 0.35 : 1;
      def.refs = refs;
      def.score = weight * (Math.log2(1 + refs) + 6 * (symbolRank.get(file.path + '\0' + def.name) || 0)) + (focusSymbols.has(def.name) ? 25 : 0) + (/^\s*(?:export|pub\b|public\b)/.test(def.signature) ? 0.5 : 0);
      defScores.push(def.score);
    }
    // Rank by a file's strongest definitions, not their count, so huge files
    // do not crowd out small central modules.
    // PageRank over the reference graph carries most of the weight: a file is
    // central when central files use it, and with a focus the files it uses and
    // the files that use it rise with it.
    let score = 0.35 * defScores.sort((a, b) => b - a).slice(0, 8).reduce((sum, value) => sum + value, 0) + 40 * (fileRank.get(file.path) || 0);
    if (isFocusFile(file)) score += 50;
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
    ...(options.includeRanking ? { ranking: files.map((file) => ({ path: file.path, score: Number(file.score.toFixed(3)), symbols: file.defs.map((def) => ({ name: def.name, refs: def.refs })) })) } : {}),
    hint: omitted.length
      ? omitted.length + ' lower-ranked file(s) omitted to fit the ' + maxChars + '-character budget. Pass path=<dir>, focus=[files or symbols] or a larger max_chars to see them.'
      : 'Files are ranked by PageRank over which files use symbols defined in which (personalized to focus when given). Use read_file with a line offset to open a definition.'
  };
}
