// Hierarchical memory, like Claude Code's CLAUDE.md files.
//   user     ~/.config/oasis/OASIS.md and ~/.claude/CLAUDE.md  (all projects),
//            plus ~/.codex/AGENTS.md and ~/.gemini/GEMINI.md
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
import { cleanInstructionText } from './untrusted-content.mjs';
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
    // Personal instructions kept for Codex and Gemini CLI apply too (OASIS_OTHER_AGENT_RULES=0 skips them).
    ...(env.OASIS_OTHER_AGENT_RULES === '0' ? [] : [
      { label: 'user', path: path.join(env.CODEX_HOME || path.join(options.home || env.HOME || os.homedir(), '.codex'), 'AGENTS.md') },
      { label: 'user', path: path.join(options.home || env.HOME || os.homedir(), '.gemini', 'GEMINI.md') }
    ]),
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
      const imported = cleanInstructionText(relative, await readFile(target, 'utf8'), null);
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
    content = cleanInstructionText(path.basename(file.path), content, notices);
    // Many repositories keep identical copies (CLAUDE.md = AGENTS.md = GEMINI.md); load one.
    const fingerprint = content.replace(/\s+/g, ' ').trim();
    if (file.label !== 'readme' && seen.has('content:' + fingerprint)) continue;
    seen.add('content:' + fingerprint);
    if (file.label !== 'readme') content = await readImports(root, content);
    const name = file.label === 'user' || file.label === 'parent' ? file.path.replace(os.homedir(), '~') : path.relative(path.resolve(root), file.path);
    const heading = file.label === 'user' ? 'User memory (applies to all projects)' : file.label === 'local' ? 'Personal project memory' : file.label === 'parent' ? 'Parent directory memory' : 'Project context';
    const block = '--- ' + heading + ': ' + name + ' ---\n' + (file.label === 'readme' ? readmeText(content).slice(0, PER_FILE_LIMIT) : clipInstruction(name, content, notices));
    if (file.label === 'readme') readmePart = block;
    else parts.push(block);
  }
  const env = options.env || process.env;
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(options.home || env.HOME || os.homedir(), '.claude');
  const rules = await projectRules(root, { env, notices, home: options.home });
  // Scoped instructions are deliberately excluded from base memory to keep the prompt small.
  const requested = [];
  for (const rule of rules) {
    if (rule.mode === 'scoped' || rule.mode === 'manual' || seen.has(rule.real)) continue;
    seen.add(rule.real);
    if (rule.mode === 'requested') { requested.push(rule); continue; }
    const fingerprint = rule.body.replace(/\s+/g, ' ').trim();
    if (!fingerprint || seen.has('content:' + fingerprint)) continue;
    seen.add('content:' + fingerprint);
    const shown = rule.label.startsWith('.claude/rules/') || rule.label.startsWith('~/') ? rule.name : rule.label;
    parts.push('--- ' + (rule.scope === 'user' ? 'User rule' : 'Project rule') + ': ' + shown + ' ---\n' + clipInstruction('rule ' + shown, cleanInstructionText('rule ' + shown, rule.body, notices), notices));
  }
  if (requested.length) {
    parts.push('--- Rules available on request ---\nRead a rule with read_file when its description fits the task:\n' + requested.slice(0, 40).map((rule) => '- ' + rule.label + (rule.description ? ': ' + cleanInstructionText('rule ' + rule.label, rule.description, notices).replace(/\s+/g, ' ') : '')).join('\n'));
  }
  const imported = await claudeAutoMemoryBlock(root, { env, home: options.home, notices });
  if (imported) parts.push(imported);
  // README is background, not instructions: it only gets whatever budget the real instruction files leave.
  if (readmePart) parts.push(readmePart);
  const joined = parts.join('\n\n');
  if (joined.length <= MAX_TOTAL) return joined;
  const marker = '\n[... instruction budget of ' + MAX_TOTAL + ' characters reached: ' + (joined.length - MAX_TOTAL) + ' characters of the files above were not loaded ...]';
  const instructionsOnly = parts.slice(0, readmePart ? -1 : undefined).join('\n\n');
  if (instructionsOnly.length > MAX_TOTAL - marker.length) notices.push('Instruction files total ' + instructionsOnly.length + ' characters; only the first ' + MAX_TOTAL + ' were loaded.');
  return joined.slice(0, MAX_TOTAL - marker.length) + marker;
}

// README as background: drop markup the model cannot use (HTML comments, badges,
// images, layout tags) so the character budget goes to the actual prose.
export function readmeText(content) {
  return String(content)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .replace(/<\/?(?:p|div|a|picture|source|table|tr|td|th|tbody|thead|br|sup|sub|span|details|summary|center|strong|em|b|i)\b[^>]*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (match, level, text) => '#'.repeat(Number(level)) + ' ' + text.trim())
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Claude Code rules: every .md file under a rules/ directory (recursive, sorted).
// Other agents' rule folders, read natively with their own trigger semantics:
// always-on, glob-scoped (loaded when a matching file is touched), on request
// (listed by description; the model reads the file when relevant) or manual (skipped).
export const OTHER_AGENT_RULE_DIRS = [
  { dir: '.cursor/rules', ext: ['.mdc', '.md'], tool: 'Cursor' },
  { dir: '.windsurf/rules', ext: ['.md'], tool: 'Windsurf' },
  { dir: '.agent/rules', ext: ['.md'], tool: 'Antigravity' },
  { dir: '.agents/rules', ext: ['.md'], tool: 'Antigravity' },
  { dir: '.github/instructions', ext: ['.instructions.md'], tool: 'Copilot' },
  { dir: '.kiro/steering', ext: ['.md'], tool: 'Kiro' },
  { dir: '.clinerules', ext: ['.md', '.txt'], tool: 'Cline' },
  { dir: '.roo/rules', ext: ['.md', '.txt'], tool: 'Roo Code' }
];

export async function projectRules(root, { env = process.env, notices = null, home = null } = {}) {
  const workspace = path.resolve(root);
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home || env.HOME || os.homedir(), '.claude');
  const rules = [
    ...await loadRules(path.join(claudeHome, 'rules'), 'user', null, notices),
    ...await loadRules(path.join(workspace, '.claude', 'rules'), 'project', workspace, notices, { prefix: '.claude/rules/' })
  ];
  if (env.OASIS_OTHER_AGENT_RULES !== '0') {
    for (const spec of OTHER_AGENT_RULE_DIRS) rules.push(...await loadRules(path.join(workspace, ...spec.dir.split('/')), 'project', workspace, notices, { ext: spec.ext, prefix: spec.dir + '/' }));
  }
  return rules;
}

async function loadRules(dir, scope, workspace = null, notices = null, { ext = ['.md'], prefix = '' } = {}) {
  const out = [];
  try { if (!(await lstat(dir)).isDirectory()) return out; } catch { return out; }
  const walk = async (current, depth) => {
    if (depth > 4 || out.length >= 60) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && ext.some((suffix) => entry.name.endsWith(suffix))) {
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
          const { paths, body, mode, description } = splitRuleFrontMatter(text);
          const name = path.relative(dir, full).split(path.sep).join('/');
          out.push({ scope, real, name, label: (prefix || (scope === 'user' ? '~/.claude/rules/' : '.claude/rules/')) + name, paths, mode, description, body: workspace ? await readImports(workspace, body) : body });
        } catch {}
      }
    }
  };
  await walk(dir, 0);
  return out;
}

function frontMatterFields(block) {
  const fields = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const inline = m[2].trim();
    const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, '');
    if (inline.startsWith('[')) fields[key] = inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
    else if (inline) fields[key] = unquote(inline);
    else {
      const list = [];
      for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) list.push(unquote(lines[j].replace(/^\s*-\s+/, '')));
      fields[key] = list;
    }
  }
  return fields;
}

const listOf = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map((item) => String(item).trim()).filter(Boolean);

// Front matter of Claude (paths), Cursor (alwaysApply, globs, description), Windsurf and
// Antigravity (trigger: always_on | glob | model_decision | manual, globs), Copilot
// (applyTo) and Kiro (inclusion: always | fileMatch | manual, fileMatchPattern).
function splitRuleFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { paths: [], body: text, mode: 'always', description: '' };
  const f = frontMatterFields(match[1]);
  const body = text.slice(match[0].length);
  const description = typeof f.description === 'string' ? f.description.slice(0, 300) : '';
  let paths = [...listOf(f.paths), ...listOf(f.globs), ...listOf(f.applyto), ...listOf(f.filematchpattern)];
  const trigger = String(f.trigger || f.inclusion || '').toLowerCase().replace(/[\s-]/g, '_');
  let mode;
  if (String(f.alwaysapply).toLowerCase() === 'true' || ['always_on', 'always'].includes(trigger)) { mode = 'always'; paths = []; }
  else if (['manual'].includes(trigger)) mode = 'manual';
  else if (['model_decision', 'agent_requested', 'auto'].includes(trigger) && !paths.length) mode = 'requested';
  else if (paths.length) mode = 'scoped';
  else if (String(f.alwaysapply).toLowerCase() === 'false') mode = description ? 'requested' : 'manual';
  else mode = 'always';
  if (paths.some((p) => p === '**' || p === '**/*')) { mode = 'always'; paths = []; }
  return { paths: mode === 'scoped' ? paths.slice(0, 20) : [], body, mode, description };
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
        const raw = cleanInstructionText(shown, await readFile(file, 'utf8'), options.notices);
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
  const scoped = (await projectRules(workspace, { env, home: options.home }))
    .filter((rule) => rule.mode === 'scoped' && rule.paths.length && rule.paths.some((pattern) => rulePathMatches(pattern, targetRelative)));
  scoped.sort((a, b) => ruleSpecificity(a) - ruleSpecificity(b) || (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'user' ? -1 : 1));
  for (const rule of scoped) {
    const key = 'scoped-rule:' + rule.real + ':' + targetRelative;
    if (loaded.has(key)) continue;
    loaded.add(key);
    found.push({ path: rule.label, text: '[Path-scoped ' + rule.scope + ' rule matching ' + targetRelative + ']\n' + rule.body.slice(0, PER_FILE_LIMIT) });
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

// Claude Code's auto memory for this repository (~/.claude/projects/<project>/memory/),
// so what it learned carries over: MEMORY.md (first 200 lines / 25 KB, as Claude Code
// loads it) plus the newest topic files within a small budget. Read-only; OASIS keeps
// its own memories separately. OASIS_IMPORT_CLAUDE_MEMORY=0 skips it.
const CLAUDE_MEMORY_INDEX_LINES = 200;
const CLAUDE_MEMORY_INDEX_BYTES = 25 * 1024;
const CLAUDE_MEMORY_TOPIC_BUDGET = 8000;

/** The repository root Claude Code keys auto memory on: the main checkout for worktrees, else the git top level, else the folder. */
export async function claudeProjectRoot(root) {
  let dir = path.resolve(root);
  for (let i = 0; i < 40; i++) {
    const marker = path.join(dir, '.git');
    try {
      const info = await lstat(marker);
      if (info.isDirectory()) return dir;
      if (info.isFile()) {
        const text = await readFile(marker, 'utf8');
        const gitdir = (text.match(/^gitdir:\s*(.+)$/m) || [])[1];
        if (gitdir) {
          const resolved = path.resolve(dir, gitdir.trim());
          const m = resolved.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
          if (m) return m[1];
        }
        return dir;
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(root);
}

export function claudeProjectDirName(projectRoot) {
  return String(projectRoot).replace(/[^a-zA-Z0-9]/g, '-');
}

async function claudeAutoMemoryDir(root, env, home) {
  const userHome = home || env.HOME || os.homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(userHome, '.claude');
  // Only the user's own Claude settings may move it; a repository cannot point OASIS elsewhere.
  try {
    const settings = JSON.parse(await readFile(path.join(claudeHome, 'settings.json'), 'utf8'));
    const custom = settings && typeof settings.autoMemoryDirectory === 'string' ? settings.autoMemoryDirectory.trim() : '';
    if (custom.startsWith('~/')) return path.join(userHome, custom.slice(2));
    if (custom && path.isAbsolute(custom)) return custom;
  } catch {}
  const name = env.CLAUDE_CODE_PROJECT_DIR_NAME && env.CLAUDE_CONFIG_DIR && !/[\\/]|^\.\.?$/.test(env.CLAUDE_CODE_PROJECT_DIR_NAME)
    ? env.CLAUDE_CODE_PROJECT_DIR_NAME
    : claudeProjectDirName(await claudeProjectRoot(root));
  return path.join(claudeHome, 'projects', name, 'memory');
}

async function readSmallTextFile(file, limit) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 256 * 1024) return null;
    const text = await readFile(file, 'utf8');
    if (text.includes('\0')) return null;
    return { text: text.slice(0, limit), mtime: info.mtimeMs };
  } catch { return null; }
}

export async function claudeAutoMemoryBlock(root, { env = process.env, home, notices = [] } = {}) {
  if (env.OASIS_IMPORT_CLAUDE_MEMORY === '0' || env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') return '';
  const dir = await claudeAutoMemoryDir(root, env, home);
  const index = await readSmallTextFile(path.join(dir, 'MEMORY.md'), CLAUDE_MEMORY_INDEX_BYTES);
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').sort(); } catch {}
  if (!index && !names.length) return '';
  const sections = [];
  if (index && index.text.trim()) sections.push(cleanInstructionText('Claude Code MEMORY.md', index.text.split('\n').slice(0, CLAUDE_MEMORY_INDEX_LINES).join('\n'), notices).trim());
  const topics = (await Promise.all(names.slice(0, 200).map(async (name) => ({ name, file: await readSmallTextFile(path.join(dir, name), 4000) })))).filter((t) => t.file && t.file.text.trim());
  topics.sort((a, b) => b.file.mtime - a.file.mtime);
  let budget = CLAUDE_MEMORY_TOPIC_BUDGET;
  const skipped = [];
  for (const topic of topics) {
    const body = cleanInstructionText('Claude Code memory ' + topic.name, topic.file.text, notices).trim();
    const piece = '### ' + topic.name + '\n' + body;
    if (piece.length > budget) { skipped.push(topic.name); continue; }
    budget -= piece.length;
    sections.push(piece);
  }
  if (skipped.length) sections.push('(Not loaded for space: ' + skipped.slice(0, 20).join(', ') + (skipped.length > 20 ? ', …' : '') + '.)');
  if (!sections.length) return '';
  const shown = dir.startsWith(os.homedir()) ? '~' + dir.slice(os.homedir().length) : dir;
  return '--- Claude Code auto memory for this repository (imported, read-only; may be out of date, so verify before relying on it): ' + shown + ' ---\n' + sections.join('\n\n');
}
