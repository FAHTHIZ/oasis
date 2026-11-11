// Structural code search with ast-grep (https://ast-grep.github.io): patterns
// are written as code with $META variables, so `foo($A)` finds every call of
// foo with one argument regardless of spacing, comments or line breaks, across
// 25+ languages. The tool is offered only when an ast-grep binary is installed
// (PATH, the project's node_modules/.bin, or OASIS_AST_GREP_PATH).
//
// The tool is read-only. With `rewrite` it previews the change as a diff and
// returns ready-to-use multi_edit edits; the write itself then goes through
// multi_edit, so approvals, plan mode, protected paths, checkpoints and undo
// all apply unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath, sensitivePath } from './tools.mjs';
import { filterAgentIgnored } from './agent-ignore.mjs';
import { lineDiff } from './markdown.mjs';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';

export const AST_GREP_TOOL_DEFINITION = { type: 'function', function: {
  name: 'ast_grep',
  description: 'Structural code search (and rewrite preview) with ast-grep. The pattern is code, not a regex: $NAME matches one node, $$$ARGS any number of nodes, e.g. `console.log($$$A)`, `if ($C) { return $X }`, `def $F($$$P): $$$B`, `foo($A, $A)` (same node twice). Whitespace, comments and line breaks do not matter. Prefer it over grep when the question is about code shape (calls with certain arguments, missing awaits, specific JSX, a function used as a callback). ' +
    'With rewrite (e.g. pattern `oldFn($$$A)`, rewrite `newFn($$$A)`) nothing is written: you get a diff and per-file multi_edit edits; apply them with multi_edit. Respects .gitignore and skips secret files.',
  parameters: { type: 'object', properties: {
    pattern: { type: 'string', description: 'ast-grep pattern written as code, with $META / $$$META variables' },
    lang: { type: 'string', description: 'Language of the pattern (ts, tsx, js, py, go, rs, java, c, cpp, cs, rb, php, kotlin, swift, lua, html, css, bash, yaml, json, ...). Optional: inferred from each file extension' },
    path: { type: 'string', description: 'Workspace-relative file or directory; default .' },
    globs: { type: 'array', items: { type: 'string' }, description: 'Include/exclude globs, e.g. ["src/**/*.ts", "!**/*.test.ts"]' },
    rewrite: { type: 'string', description: 'Replacement template using the same $META variables; returns a preview and multi_edit edits, never writes' },
    strictness: { type: 'string', enum: ['cst', 'smart', 'ast', 'relaxed', 'signature'], description: 'Match strictness; default smart' },
    max_results: { type: 'integer', description: '1-500; default 100' }
  }, required: ['pattern'], additionalProperties: false } } };

let cached = null;

function looksLikeAstGrep(binary, env) {
  try {
    const out = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env });
    return out.status === 0 && /ast-grep/i.test(String(out.stdout || '') + String(out.stderr || ''));
  } catch { return false; }
}

/** Path of a working ast-grep binary, or '' if none. `sg` is only accepted when it really is ast-grep (on Linux it is often setgroups). */
export function resolveAstGrep(root = process.cwd(), env = process.env) {
  if (/^(0|false|no|off)$/i.test(String(env.OASIS_AST_GREP || '').trim())) return '';
  const explicit = String(env.OASIS_AST_GREP_PATH || '').trim();
  const key = explicit + '\0' + root + '\0' + (env.PATH || '');
  if (cached && cached.key === key) return cached.binary;
  // Real executables only, never .cmd shims: those need a shell, and code
  // patterns full of $ | & ( ) must not pass through one.
  const exe = process.platform === 'win32' ? '.exe' : '';
  const packaged = (base) => path.join(base, 'node_modules', '@ast-grep', 'cli', 'ast-grep' + exe);
  const candidates = [
    ...(explicit ? [explicit] : []),
    packaged(root),
    ...(process.platform === 'win32' && env.APPDATA ? [packaged(path.join(env.APPDATA, 'npm'))] : []),
    'ast-grep',
    'sg'
  ];
  let binary = '';
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
    if (/\.(cmd|bat|ps1)$/i.test(candidate)) continue;
    if (looksLikeAstGrep(candidate, env)) { binary = candidate; break; }
  }
  cached = { key, binary };
  return binary;
}

export function resetAstGrepCache() { cached = null; }

const STRICTNESS = new Set(['cst', 'smart', 'ast', 'relaxed', 'signature']);
const LANG = /^[A-Za-z][A-Za-z0-9_+#-]{0,19}$/;

function runBinary(binary, argv, { cwd, env, signal, maxResults }) {
  return new Promise((resolve) => {
    const child = spawn(binary, argv, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const matches = [];
    let buffer = '';
    let stderr = '';
    let truncated = false;
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, matches, stderr, truncated }); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += '\nast-grep timed out after 60 seconds.'; finish(null); }, 60000);
    if (signal) signal.addEventListener('abort', () => { child.kill('SIGKILL'); finish(null); }, { once: true });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { matches.push(JSON.parse(line)); } catch { continue; }
        if (matches.length > maxResults) { truncated = true; matches.length = maxResults; child.kill('SIGKILL'); finish(0); return; }
      }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk; });
    child.on('error', (error) => { stderr += error.message; finish(-1); });
    child.on('close', (code) => {
      const rest = buffer.trim();
      if (rest) { try { matches.push(JSON.parse(rest)); } catch {} }
      finish(code);
    });
  });
}

function cleanHint(stderr) {
  return String(stderr || '').split('\n').map((line) => line.trim()).filter((line) => line && !/playground|^See also/i.test(line)).join(' ').slice(0, 400);
}

/** Byte-offset replacements applied to a Buffer (ast-grep reports UTF-8 byte offsets). */
export function applyReplacements(content, replacements) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let out = buffer;
  let lastStart = Infinity;
  for (const item of sorted) {
    if (item.end > lastStart) continue; // overlapping matches: keep the outer-most later one only
    out = Buffer.concat([out.subarray(0, item.start), Buffer.from(item.text, 'utf8'), out.subarray(item.end)]);
    lastStart = item.start;
  }
  return out.toString('utf8');
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) count++;
  return count;
}

/**
 * multi_edit edits that turn `before` into `after`, one per group of changed
 * lines, each old_string widened with surrounding lines until it is unique.
 */
export function editsForChange(before, after) {
  const ops = lineDiff(before, after);
  const oldLines = String(before).split('\n');
  // Map each diff op to its position in the old file, collecting changed hunks.
  const hunks = [];
  let oldIndex = 0;
  let current = null;
  for (const op of ops) {
    if (op.op === ' ') {
      if (current) { hunks.push(current); current = null; }
      oldIndex++;
      continue;
    }
    if (!current) current = { start: oldIndex, end: oldIndex, added: [] };
    if (op.op === '-') { oldIndex++; current.end = oldIndex; }
    else current.added.push(op.line);
  }
  if (current) hunks.push(current);
  const edits = [];
  for (const hunk of hunks) {
    let start = hunk.start;
    let end = hunk.end;
    const build = () => {
      const oldText = oldLines.slice(start, end).join('\n');
      const prefix = oldLines.slice(start, hunk.start);
      const suffix = oldLines.slice(hunk.end, end);
      const newText = [...prefix, ...hunk.added, ...suffix].join('\n');
      return { oldText, newText };
    };
    let { oldText, newText } = build();
    for (let widen = 0; widen < 12 && (oldText === '' || countOccurrences(before, oldText) !== 1); widen++) {
      if (start > 0) start--;
      if (end < oldLines.length) end++;
      ({ oldText, newText } = build());
      if (start === 0 && end === oldLines.length) break;
    }
    edits.push({ old_string: oldText, new_string: newText });
  }
  return edits;
}

function renderPlainDiff(file, before, after, maxLines = 80) {
  const lines = createTwoFilesPatch('a/' + file, 'b/' + file, before, after, '', '', { context: 2, headerOptions: FILE_HEADERS_ONLY }).trimEnd().split('\n');
  if (lines.length > maxLines) return lines.slice(0, maxLines).join('\n') + '\n… ' + (lines.length - maxLines) + ' more diff lines';
  return lines.join('\n');
}

export async function runAstGrep(root, args = {}, context = {}) {
  const env = context.env || process.env;
  const pattern = String(args.pattern || '');
  if (!pattern.trim()) throw new Error('ast_grep needs a pattern.');
  if (pattern.length > 4000) throw new Error('Pattern is too long.');
  const binary = resolveAstGrep(root, env);
  if (!binary) {
    return { error: 'ast-grep is not installed.', hint: 'Install it with `npm i -g @ast-grep/cli`, `pip install ast-grep-cli`, `brew install ast-grep` or `cargo install ast-grep --locked`, then start a new session. Use grep meanwhile.' };
  }
  const maxResults = Math.max(1, Math.min(500, Number.parseInt(args.max_results, 10) || 100));
  const target = await resolveWorkspacePath(root, args.path || '.');
  const relTarget = path.relative(target.root, target.absolute) || '.';
  const argv = ['run', '--pattern=' + pattern, '--json=stream', '--color=never'];
  if (args.lang) {
    if (!LANG.test(String(args.lang))) throw new Error('Unknown language name: ' + String(args.lang).slice(0, 40));
    argv.push('--lang=' + String(args.lang));
  }
  if (args.strictness) {
    if (!STRICTNESS.has(String(args.strictness))) throw new Error('strictness must be one of ' + [...STRICTNESS].join(', '));
    argv.push('--strictness=' + args.strictness);
  }
  const rewrite = typeof args.rewrite === 'string' ? args.rewrite : null;
  if (rewrite !== null) {
    if (rewrite.length > 8000) throw new Error('Rewrite template is too long.');
    argv.push('--rewrite=' + rewrite);
  }
  const globs = Array.isArray(args.globs) ? args.globs : typeof args.globs === 'string' && args.globs ? [args.globs] : [];
  if (globs.length > 20) throw new Error('At most 20 globs.');
  for (const glob of globs) {
    const text = String(glob);
    if (!text || text.length > 300 || text.includes('\0')) throw new Error('Invalid glob.');
    argv.push('--globs=' + text);
  }
  argv.push('--', relTarget.split(path.sep).join('/'));
  const run = await runBinary(binary, argv, { cwd: target.root, env, signal: context.signal, maxResults: rewrite !== null ? 2000 : maxResults });
  if (run.code !== 0 && run.code !== 1 && !run.matches.length) {
    return { error: 'ast-grep failed' + (run.code === null ? '' : ' (exit ' + run.code + ')') + ': ' + cleanHint(run.stderr), pattern };
  }
  const visible = await filterAgentIgnored(run.matches.filter((match) => match && typeof match.file === 'string' && !sensitivePath(match.file)), (match) => path.resolve(target.root, match.file), { env });
  const hint = /ERROR node|matched nothing/i.test(run.stderr) ? cleanHint(run.stderr) : '';
  if (rewrite === null) {
    const matches = visible.map((match) => {
      const single = match.metaVariables && match.metaVariables.single || {};
      const multi = match.metaVariables && match.metaVariables.multi || {};
      const vars = {};
      for (const [name, value] of Object.entries(single)) vars[name] = String(value && value.text || '').slice(0, 200);
      for (const [name, list] of Object.entries(multi)) {
        if (name === 'secondary') continue;
        vars['$$' + name] = (Array.isArray(list) ? list : []).map((item) => item.text).filter((text) => text !== ',').join(', ').slice(0, 200);
      }
      return {
        file: match.file,
        line: (match.range && match.range.start && match.range.start.line || 0) + 1,
        column: (match.range && match.range.start && match.range.start.column || 0) + 1,
        text: String(match.text || '').slice(0, 400) + (String(match.text || '').length > 400 ? '…' : ''),
        ...(Object.keys(vars).length ? { vars } : {})
      };
    });
    return { engine: 'ast-grep', pattern, count: matches.length, truncated: run.truncated, matches, ...(hint && !matches.length ? { hint } : {}) };
  }
  // Rewrite preview: group replacements per file and compute the result locally.
  const byFile = new Map();
  for (const match of visible) {
    if (typeof match.replacement !== 'string') continue;
    const offsets = match.replacementOffsets || (match.range && match.range.byteOffset);
    if (!offsets) continue;
    if (!byFile.has(match.file)) byFile.set(match.file, []);
    byFile.get(match.file).push({ start: offsets.start, end: offsets.end, text: match.replacement });
  }
  const files = [];
  let skipped = 0;
  let totalReplacements = 0;
  for (const [file, replacements] of byFile) {
    if (files.length >= 50) { skipped += 1; continue; }
    let before;
    try {
      const resolved = await resolveWorkspacePath(target.root, file);
      before = await readFile(resolved.absolute);
    } catch { skipped += 1; continue; }
    const beforeText = before.toString('utf8');
    const afterText = applyReplacements(before, replacements);
    if (afterText === beforeText) continue;
    totalReplacements += replacements.length;
    files.push({ path: file, replacements: replacements.length, diff: renderPlainDiff(file, beforeText, afterText), edits: editsForChange(beforeText, afterText) });
  }
  return {
    engine: 'ast-grep',
    pattern,
    rewrite,
    preview: true,
    written: false,
    files_changed: files.length,
    replacements: totalReplacements,
    ...(skipped ? { files_not_shown: skipped } : {}),
    ...(run.truncated ? { truncated: true, note: 'More than 2000 matches; only the first 2000 are included. Narrow path or globs and run again.' } : {}),
    files,
    next_step: files.length ? 'Nothing was written. Review the diff, then apply each file with multi_edit using its path and edits.' : 'No code matched, so there is nothing to rewrite.',
    ...(hint && !files.length ? { hint } : {})
  };
}
