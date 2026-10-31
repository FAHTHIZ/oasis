// Hierarchical memory, like Claude Code's CLAUDE.md files.
//   user     ~/.config/oasis/OASIS.md and ~/.claude/CLAUDE.md  (all projects)
//   project  OASIS.md, AGENTS.md, CLAUDE.md                     (shared, committed)
//            plus GEMINI.md, .github/copilot-instructions.md, .cursorrules,
//            .windsurfrules, .clinerules, CONVENTIONS.md (other agents' rules)
//   local    OASIS.local.md, CLAUDE.local.md                    (personal, gitignored)
// README.md is still included as general project context.
//   parent   CLAUDE.md, CLAUDE.local.md, AGENTS.md, OASIS.md in directories above the
//            workspace (monorepos), nearest last, as Claude Code walks up from the cwd
//   rules    .claude/rules/**/*.md (project) and ~/.claude/rules/**/*.md (user); a
//            "paths:" front-matter list scopes a rule to matching files
// Lines starting with "@path" inside a memory file include that workspace file.
import { appendFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const MAX_MEMORY_FILE = 40 * 1024;
const MAX_TOTAL = 40000;
const PER_FILE_LIMIT = 9000;
export const OTHER_AGENT_RULES = ['GEMINI.md', path.join('.github', 'copilot-instructions.md'), '.cursorrules', '.windsurfrules', '.clinerules', 'CONVENTIONS.md'];

export function memoryFiles(root, options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const workspace = path.resolve(root);
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(options.home || env.HOME || os.homedir(), '.claude');
  const parents = [];
  if (env.OASIS_DISABLE_PARENT_MEMORY !== '1') {
    const dirs = [];
    for (let dir = path.dirname(workspace); dir && dir !== path.dirname(dir) && dirs.length < 20; dir = path.dirname(dir)) dirs.unshift(dir);
    for (const dir of dirs) for (const name of ['CLAUDE.md', 'AGENTS.md', 'OASIS.md', 'CLAUDE.local.md']) parents.push({ label: 'parent', path: path.join(dir, name) });
  }
  const candidates = [
    { label: 'user', path: path.join(getConfigDirectory(env, home), 'OASIS.md') },
    { label: 'user', path: path.join(claudeHome, 'CLAUDE.md') },
    ...parents,
    { label: 'project', path: path.join(workspace, 'OASIS.md') },
    { label: 'project', path: path.join(workspace, 'AGENTS.md') },
    { label: 'project', path: path.join(workspace, 'CLAUDE.md') },
    { label: 'project', path: path.join(workspace, '.claude', 'CLAUDE.md') },
    // Instructions written for other coding agents, so a repository set up for
    // Gemini CLI, Copilot, Cursor, Windsurf, Cline or Aider works without copying files.
    ...(env.OASIS_OTHER_AGENT_RULES === '0' ? [] : OTHER_AGENT_RULES.map((name) => ({ label: 'project', path: path.join(workspace, name) }))),
    { label: 'local', path: path.join(workspace, 'OASIS.local.md') },
    { label: 'local', path: path.join(workspace, 'CLAUDE.local.md') },
    { label: 'readme', path: path.join(workspace, 'README.md') }
  ];
  return Promise.all(candidates.map(async (item) => {
    try {
      const info = await lstat(item.path);
      return { ...item, exists: info.isFile() && info.size <= MAX_MEMORY_FILE * 4, size: info.size };
    } catch { return { ...item, exists: false }; }
  }));
}

async function readImports(root, text, depth = 0) {
  if (depth > 2) return text;
  const workspace = await realpath(root).catch(() => root);
  const lines = [];
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^@((?:\.{0,2}\/)?[\w.\-/]+)$/);
    if (!match) { lines.push(line); continue; }
    try {
      const target = await realpath(path.resolve(workspace, match[1]));
      const relative = path.relative(workspace, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { lines.push(line); continue; }
      const info = await lstat(target);
      if (!info.isFile()) { lines.push(line); continue; }
      if (info.size > MAX_MEMORY_FILE) { lines.push(line + '  [not imported: ' + relative + ' is ' + info.size + ' bytes, over the ' + MAX_MEMORY_FILE + '-byte import limit; read_file it if it matters]'); continue; }
      const imported = await readFile(target, 'utf8');
      const clippedImport = imported.length > PER_FILE_LIMIT ? imported.slice(0, PER_FILE_LIMIT) + '\n[... ' + relative + ' truncated: ' + (imported.length - PER_FILE_LIMIT) + ' more characters not imported ...]' : imported;
      lines.push('--- imported ' + relative + ' ---', await readImports(root, clippedImport, depth + 1), '--- end ' + relative + ' ---');
    } catch { lines.push(line); }
  }
  return lines.join('\n');
}

function clipInstruction(name, content, notices) {
  if (content.length <= PER_FILE_LIMIT) return content;
  notices.push(name + ' is ' + content.length + ' characters; only the first ' + PER_FILE_LIMIT + ' were loaded into the prompt.');
  return content.slice(0, PER_FILE_LIMIT) + '\n[... ' + name + ' truncated: ' + (content.length - PER_FILE_LIMIT) + ' more characters not loaded. read_file it if the rest matters ...]';
}

export async function loadMemory(root, options = {}) {
  const files = await memoryFiles(root, options);
  const notices = Array.isArray(options.notices) ? options.notices : [];
  const parts = [];
  let readmePart = '';
  const seen = new Set();
  for (const file of files) {
    if (!file.exists) {
      if (file.size > MAX_MEMORY_FILE * 4 && file.label !== 'readme') notices.push(path.basename(file.path) + ' (' + file.size + ' bytes) is too large and was not loaded at all.');
      continue;
    }
    let real;
    try { real = await realpath(file.path); } catch { continue; }
    if (file.label !== 'user' && file.label !== 'parent') {
      const workspace = await realpath(path.resolve(root)).catch(() => path.resolve(root));
      const relative = path.relative(workspace, real);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let content;
    try { content = await readFile(real, 'utf8'); } catch { continue; }
    if (!content.trim() || content.includes('\0')) continue;
    // Many repositories keep identical copies (CLAUDE.md = AGENTS.md = GEMINI.md); load one.
    const fingerprint = content.replace(/\s+/g, ' ').trim();
    if (file.label !== 'readme' && seen.has('content:' + fingerprint)) continue;
    seen.add('content:' + fingerprint);
    if (file.label !== 'readme') content = await readImports(root, content);
    const name = file.label === 'user' || file.label === 'parent' ? file.path.replace(os.homedir(), '~') : path.relative(path.resolve(root), file.path);
    const heading = file.label === 'user' ? 'User memory (applies to all projects)' : file.label === 'local' ? 'Personal project memory' : file.label === 'parent' ? 'Parent directory memory' : 'Project context';
    const block = '--- ' + heading + ': ' + name + ' ---\n' + (file.label === 'readme' ? content.slice(0, PER_FILE_LIMIT) : clipInstruction(name, content, notices));
    if (file.label === 'readme') readmePart = block;
    else parts.push(block);
  }
  const env = options.env || process.env;
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(options.home || env.HOME || os.homedir(), '.claude');
  const rules = [...await loadRules(path.join(claudeHome, 'rules'), 'user', null, notices), ...await loadRules(path.join(path.resolve(root), '.claude', 'rules'), 'project', path.resolve(root), notices)];
  // Scoped instructions are deliberately excluded from base memory to keep the prompt small.
  for (const rule of rules) {
    if (rule.paths.length || seen.has(rule.real)) continue;
    seen.add(rule.real);
    parts.push('--- ' + (rule.scope === 'user' ? 'User rule' : 'Project rule') + ': ' + rule.name + ' ---\n' + clipInstruction('rule ' + rule.name, rule.body, notices));
  }
  // README is background, not instructions: it only gets whatever budget the real instruction files leave.
  if (readmePart) parts.push(readmePart);
  const joined = parts.join('\n\n');
  if (joined.length <= MAX_TOTAL) return joined;
  const marker = '\n[... instruction budget of ' + MAX_TOTAL + ' characters reached: ' + (joined.length - MAX_TOTAL) + ' characters of the files above were not loaded ...]';
  const instructionsOnly = parts.slice(0, readmePart ? -1 : undefined).join('\n\n');
  if (instructionsOnly.length > MAX_TOTAL - marker.length) notices.push('Instruction files total ' + instructionsOnly.length + ' characters; only the first ' + MAX_TOTAL + ' were loaded.');
  return joined.slice(0, MAX_TOTAL - marker.length) + marker;
}

// Claude Code rules: every .md file under a rules/ directory (recursive, sorted).
async function loadRules(dir, scope, workspace = null, notices = null) {
  const out = [];
  const walk = async (current, depth) => {
    if (depth > 4 || out.length >= 60) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const info = await lstat(full);
          if (info.size > MAX_MEMORY_FILE) { if (notices) notices.push((scope === 'user' ? 'User' : 'Project') + ' rule ' + path.relative(dir, full).split(path.sep).join('/') + ' (' + info.size + ' bytes) is over the ' + MAX_MEMORY_FILE + '-byte limit and was not loaded.'); continue; }
          const real = await realpath(full);
          if (workspace) {
            const relative = path.relative(await realpath(workspace).catch(() => workspace), real);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
          }
          const text = await readFile(real, 'utf8');
          if (!text.trim() || text.includes('\0')) continue;
          const { paths, body } = splitRuleFrontMatter(text);
          out.push({ scope, real, name: path.relative(dir, full).split(path.sep).join('/'), paths, body: workspace ? await readImports(workspace, body) : body });
        } catch {}
      }
    }
  };
  await walk(dir, 0);
  return out;
}

function splitRuleFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { paths: [], body: text };
  const paths = [];
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^paths\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.startsWith('[')) paths.push(...inline.replace(/^\[|\]$/g, '').split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    else if (inline) paths.push(...inline.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) paths.push(lines[j].replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
  }
  return { paths: paths.slice(0, 20), body: text.slice(match[0].length) };
}

// "# note" in the prompt: append a bullet to the project memory file.
export async function appendMemoryNote(root, note, options = {}) {
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!text) throw new Error('Write the note after #, for example: # use pnpm, not npm');
  const scope = options.scope || 'project';
  const target = scope === 'user'
    ? path.join(getConfigDirectory(options.env || process.env, options.home || os.homedir()), 'OASIS.md')
    : scope === 'local' ? path.join(path.resolve(root), 'OASIS.local.md') : path.join(path.resolve(root), 'OASIS.md');
  let existing = '';
  try { existing = await readFile(target, 'utf8'); } catch {}
  let prefix = '';
  if (!existing) prefix = '# Project memory\n\n';
  else if (!existing.endsWith('\n')) prefix = '\n';
  if (scope === 'user' && !existing) prefix = '# Oasis user memory\n\n';
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, prefix + '- ' + text + '\n', 'utf8');
  return target;
}

// Claude Code loads CLAUDE.md files in subdirectories only when the agent works on files there.
// Returns the not-yet-loaded memory files between the workspace root and filePath's folder,
// root-most first, and records them in `loaded` so each is sent once per session.
const NESTED_NAMES = ['CLAUDE.md', 'AGENTS.md', 'OASIS.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')];
export async function nestedMemoryFor(root, filePath, loaded = new Set(), options = {}) {
  const env = options.env || process.env;
  if (env.OASIS_DISABLE_NESTED_MEMORY === '1' || typeof filePath !== 'string' || !filePath) return [];
  const workspace = await realpath(root).catch(() => path.resolve(root));
  const target = path.resolve(workspace, filePath);
  const targetRelativeNative = path.relative(workspace, target);
  if (targetRelativeNative.startsWith('..') || path.isAbsolute(targetRelativeNative)) return [];
  const targetRelative = targetRelativeNative.split(path.sep).join('/');
  const relative = path.relative(workspace, path.dirname(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [];
  const parts = relative ? relative.split(path.sep).filter(Boolean).slice(0, 30) : [];
  const found = [];
  let budget = options.maxChars || 12000;
  for (let i = 1; i <= parts.length; i++) {
    const dir = path.join(workspace, ...parts.slice(0, i));
    if (/(^|\/)(node_modules|\.git)(\/|$)/.test(dir)) break;
    for (const name of NESTED_NAMES) {
      const file = path.join(dir, name);
      if (loaded.has(file)) continue;
      try {
        const info = await lstat(file);
        if (!info.isFile()) continue;
        const real = await realpath(file);
        const back = path.relative(workspace, real);
        if (back.startsWith('..') || path.isAbsolute(back)) continue;
        loaded.add(file);
        const shown = path.relative(workspace, file);
        if (info.size > MAX_MEMORY_FILE) {
          found.push({ path: shown, text: '[' + shown + ' applies to this directory but is ' + info.size + ' bytes, over the ' + MAX_MEMORY_FILE + '-byte limit, so it was not loaded. read_file it before editing here.]' });
          continue;
        }
        const raw = await readFile(file, 'utf8');
        let text = (await readImports(workspace, raw.slice(0, PER_FILE_LIMIT))).trim();
        if (raw.length > PER_FILE_LIMIT) text += '\n[... ' + shown + ' truncated: ' + (raw.length - PER_FILE_LIMIT) + ' more characters not loaded. read_file it if the rest matters ...]';
        if (!text) continue;
        if (budget <= 0) { found.push({ path: shown, text: '[' + shown + ' also applies here but the nested-instruction budget was used up. read_file it before editing here.]' }); continue; }
        let clipped = text.slice(0, budget);
        if (clipped.length < text.length) clipped += '\n[... nested-instruction budget reached: ' + (text.length - clipped.length) + ' characters of ' + shown + ' not loaded ...]';
        budget -= clipped.length;
        found.push({ path: shown, text: clipped });
      } catch {}
    }
  }
  // Load path-frontmatter rules only for a specific matching file, never globally.
  const envHome = options.home || env.HOME || os.homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(envHome, '.claude');
  const scoped = [
    ...await loadRules(path.join(claudeHome, 'rules'), 'user'),
    ...await loadRules(path.join(workspace, '.claude', 'rules'), 'project', workspace)
  ].filter((rule) => rule.paths.length && rule.paths.some((pattern) => rulePathMatches(pattern, targetRelative)));
  scoped.sort((a, b) => ruleSpecificity(a) - ruleSpecificity(b) || (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'user' ? -1 : 1));
  for (const rule of scoped) {
    const key = 'scoped-rule:' + rule.real + ':' + targetRelative;
    if (loaded.has(key)) continue;
    loaded.add(key);
    found.push({ path: '.claude/rules/' + rule.name, text: '[Path-scoped ' + rule.scope + ' rule matching ' + targetRelative + ']\n' + rule.body.slice(0, PER_FILE_LIMIT) });
  }
  return found;
}

function ruleSpecificity(rule) {
  return Math.max(0, ...rule.paths.map((pattern) => pattern.replace(/[*?]/g, '').length));
}

export function rulePathMatches(pattern, relativePath) {
  const p = String(pattern || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const file = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.split('/').includes('..')) return false;
  let source = '^';
  for (let i = 0; i < p.length; i++) {
    const char = p[i];
    if (char === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += '^$+?.()|[]{}'.includes(char) || char === '\\' ? '\\' + char : char;
  }
  try { return new RegExp(source + '$').test(file); } catch { return false; }
}
