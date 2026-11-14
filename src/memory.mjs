// Hierarchical memory, like Claude Code's CLAUDE.md files.
//   user     ~/.config/oasis/OASIS.md and ~/.claude/CLAUDE.md  (all projects),
//            plus ~/.codex/AGENTS.md and ~/.gemini/GEMINI.md
//   project  OASIS.md, AGENTS.md, CLAUDE.md                     (shared, committed)
//            plus GEMINI.md, .github/copilot-instructions.md, .cursorrules,
//            .windsurfrules, .clinerules, .roorules (when .roo/rules is empty),
//            CONVENTIONS.md, .goosehints (other agents' rules; Goose's also from
//            parent folders up to the git root and ~/.config/goose/.goosehints),
//            AGENT.md and Devin Desktop's .devin/global_rules.md (else the
//            legacy .windsurf/global_rules.md)
//            and the files an opencode.json / kilo.jsonc "instructions" array lists,
//            Aider .aider.conf.yml "read:" files, and Gemini CLI context.fileName names
//   local    OASIS.local.md, CLAUDE.local.md, AGENTS.local.md   (personal, gitignored)
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
import { parseFrontMatter } from './frontmatter.mjs';
import { parse as parseJsonc } from 'jsonc-parser';

// Files are read up to 4 x this (4 MiB, as Claude Code) and imports up to this.
const MAX_MEMORY_FILE = 1024 * 1024;

// Claude Code's "claudeMdExcludes": glob patterns (or absolute paths) matched
// against a memory file's absolute path; the file is skipped if either its
// path or its symlink target matches.
function excludeMatcher(patterns) {
  const list = (Array.isArray(patterns) ? patterns : []).filter((item) => typeof item === 'string' && item.trim());
  if (!list.length) return null;
  const toRegExp = (pattern) => {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (char === '*') {
        if (pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*'; } else source += '[^/]*';
      } else if (char === '?') source += '[^/]';
      else source += char.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
    }
    return new RegExp('^' + source + '$');
  };
  const regexps = list.map((pattern) => toRegExp(pattern.trim().split(path.sep).join('/')));
  return (...files) => files.some((file) => file && regexps.some((re) => re.test(path.resolve(file).split(path.sep).join('/'))));
}

// Instruction files are the user's own rules, so they load whole up to a
// high bound. The old 9,000-per-file and 40,000-total caps cut an ordinary
// AGENTS.md short; Codex keeps 32 KiB and Claude Code loads files of up to
// 4 MiB, warning above 40,000 characters for one file and 120,000 in all.
// OASIS loads up to PER_FILE_LIMIT and MAX_TOTAL and gives the same
// warnings, so a large file is visible but never silently cut.
export const MAX_TOTAL = 300_000;
export const PER_FILE_LIMIT = 150_000;
export const LARGE_INSTRUCTION_FILE = 40_000;
export const LARGE_INSTRUCTION_TOTAL = 120_000;
// The README is background sent with every request; its opening (what the
// project is, how to run it) is what helps. The model can read the rest.
const README_LIMIT = 2500;
const OTHER_AGENT_RULES = ['GEMINI.md', 'AGENT.md', path.join('.github', 'copilot-instructions.md'), '.cursorrules', '.windsurfrules', path.join('.devin', 'global_rules.md'), path.join('.windsurf', 'global_rules.md'), '.clinerules', '.roorules', 'CONVENTIONS.md', '.goosehints'];

async function isGitRoot(dir) {
  try { await lstat(path.join(dir, '.git')); return true; } catch { return false; }
}

// OpenCode's (and Kilo Code's) "instructions": an array of files or globs in opencode.json(c)
// / kilo.json(c), loaded with AGENTS.md (opencode.ai/docs/rules). Project entries resolve
// from the workspace and must stay inside it; global entries (~/.config/opencode, ~/.config/kilo)
// resolve from that folder. Remote URLs are not fetched.
const MAX_CONFIG_INSTRUCTIONS = 20;
function instructionGlob(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*'; } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}
// Files under dir (sorted, skipping node_modules and dot-git), at most `limit` entries visited.
async function walkFiles(dir, depth, limit, out = [], budget = { left: limit }) {
  let entries = [];
  try { entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { return out; }
  for (const entry of entries) {
    if (--budget.left < 0) break;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) out.push(full);
    else if (entry.isDirectory() && depth > 0) await walkFiles(full, depth - 1, limit, out, budget);
  }
  return out;
}
async function configInstructionFiles(workspace, env, home) {
  if (env.OASIS_OTHER_AGENT_RULES === '0') return [];
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const configs = [];
  for (const [dir, label] of [[path.join(configHome, 'opencode'), 'user'], [path.join(configHome, 'kilo'), 'user'], [workspace, 'project']]) {
    for (const name of ['opencode.json', 'opencode.jsonc', 'kilo.json', 'kilo.jsonc']) configs.push({ file: path.join(dir, name), base: dir, label });
  }
  const out = [];
  for (const { file, base, label } of configs) {
    let data;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      data = parseJsonc(await readFile(file, 'utf8'), [], { allowTrailingComma: true });
    } catch { continue; }
    const list = data && Array.isArray(data.instructions) ? data.instructions : [];
    for (const entry of list.slice(0, 50)) {
      if (typeof entry !== 'string' || !entry.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) || entry.includes('\0')) continue;
      const raw = entry.trim().replace(/^~(?=\/|$)/, home);
      const absolute = path.resolve(base, raw).split(path.sep).join('/');
      if (!/[*?]/.test(raw)) { out.push({ label, path: path.resolve(base, raw) }); continue; }
      const staticPart = absolute.slice(0, absolute.search(/[*?]/)).replace(/\/[^/]*$/, '') || '/';
      const regexp = instructionGlob(absolute);
      for (const candidate of await walkFiles(staticPart, 6, 5000)) {
        if (regexp.test(candidate.split(path.sep).join('/'))) out.push({ label, path: candidate });
        if (out.length >= MAX_CONFIG_INSTRUCTIONS) return out;
      }
    }
    if (out.length >= MAX_CONFIG_INSTRUCTIONS) break;
  }
  return out.slice(0, MAX_CONFIG_INSTRUCTIONS);
}

// Gemini CLI's context.fileName (a name or list of names, default GEMINI.md) in
// ~/.gemini/settings.json and .gemini/settings.json; plain file names only, up to 10.
async function geminiContextNames(workspace, env = process.env, home = os.homedir()) {
  const names = [];
  for (const file of [path.join(home, '.gemini', 'settings.json'), path.join(workspace, '.gemini', 'settings.json')]) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      const data = parseJsonc(await readFile(file, 'utf8'), [], { allowTrailingComma: true });
      const value = data && data.context && typeof data.context === 'object' ? data.context.fileName : undefined;
      const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
      if (list.length) names.length = 0; // the workspace setting replaces the user one
      for (const name of list) if (typeof name === 'string' && /^[\w.-]{1,100}$/.test(name) && !/^\.+$/.test(name) && !names.includes(name) && names.length < 10) names.push(name);
    } catch { /* no settings */ }
  }
  return names.length ? names : ['GEMINI.md'];
}

// Aider's .aider.conf.yml "read:" files (read-only context; aider.chat/docs/config/aider_conf.html),
// from the home folder, the git root and the workspace. Relative names resolve from the workspace.
async function aiderReadFiles(workspace, env, home) {
  const configs = [path.join(home, '.aider.conf.yml')];
  for (let dir = workspace, i = 0; i < 20; i++) {
    try { await lstat(path.join(dir, '.git')); if (dir !== workspace) configs.push(path.join(dir, '.aider.conf.yml')); break; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  configs.push(path.join(workspace, '.aider.conf.yml'));
  const out = [];
  const { parse } = await import('yaml');
  for (const file of configs) {
    let data;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 256 * 1024) continue;
      data = parse(await readFile(file, 'utf8'), { schema: 'core', maxAliasCount: 20 });
    } catch { continue; }
    const value = data && typeof data === 'object' ? data.read : undefined;
    const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    for (const entry of list.slice(0, 20)) {
      if (typeof entry !== 'string' || !entry.trim() || entry.includes('\0')) continue;
      const raw = entry.trim().replace(/^~(?=\/|$)/, home);
      out.push({ label: path.isAbsolute(raw) && file === configs[0] ? 'user' : 'project', path: path.resolve(workspace, raw) });
    }
  }
  return out.slice(0, MAX_CONFIG_INSTRUCTIONS);
}

export async function memoryFiles(root, options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const workspace = path.resolve(root);
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(options.home || env.HOME || os.homedir(), '.claude');
  const parents = [];
  if (env.OASIS_DISABLE_PARENT_MEMORY !== '1') {
    const dirs = [];
    for (let dir = path.dirname(workspace); dir && dir !== path.dirname(dir) && dirs.length < 20; dir = path.dirname(dir)) dirs.unshift(dir);
    for (const dir of dirs) for (const name of ['CLAUDE.md', 'AGENTS.md', 'OASIS.md', 'CLAUDE.local.md']) parents.push({ label: 'parent', path: path.join(dir, name) });
    // Goose reads .goosehints in each directory from the git root down to the cwd.
    if (env.OASIS_OTHER_AGENT_RULES !== '0' && !await isGitRoot(workspace)) {
      let gitRoot = -1;
      for (let i = dirs.length - 1; i >= 0; i--) if (await isGitRoot(dirs[i])) { gitRoot = i; break; }
      if (gitRoot >= 0) for (const dir of dirs.slice(gitRoot)) parents.push({ label: 'parent', path: path.join(dir, '.goosehints') });
    }
  }
  const candidates = [
    { label: 'user', path: path.join(getConfigDirectory(env, home), 'OASIS.md') },
    { label: 'user', path: path.join(claudeHome, 'CLAUDE.md') },
    // Personal instructions kept for Codex and Gemini CLI apply too (OASIS_OTHER_AGENT_RULES=0 skips them).
    ...(env.OASIS_OTHER_AGENT_RULES === '0' ? [] : [
      { label: 'user', path: path.join(env.CODEX_HOME || path.join(options.home || env.HOME || os.homedir(), '.codex'), 'AGENTS.md') },
      { label: 'user', path: path.join(options.home || env.HOME || os.homedir(), '.gemini', 'GEMINI.md') },
      // Devin Desktop (formerly Windsurf) global rules, and the legacy Windsurf location.
      { label: 'user', path: path.join(options.home || env.HOME || os.homedir(), '.devin', 'global_rules.md') },
      { label: 'user', path: path.join(options.home || env.HOME || os.homedir(), '.codeium', 'windsurf', 'memories', 'global_rules.md') },
      // Goose global hints.
      { label: 'user', path: path.join(env.XDG_CONFIG_HOME || path.join(options.home || env.HOME || os.homedir(), '.config'), 'goose', '.goosehints') }
    ]),
    ...parents,
    { label: 'project', path: path.join(workspace, 'OASIS.md') },
    { label: 'project', path: path.join(workspace, 'AGENTS.md') },
    { label: 'project', path: path.join(workspace, 'CLAUDE.md') },
    { label: 'project', path: path.join(workspace, '.claude', 'CLAUDE.md') },
    // Instructions written for other coding agents, so a repository set up for
    // Gemini CLI, Copilot, Cursor, Windsurf, Cline or Aider works without copying files.
    ...(env.OASIS_OTHER_AGENT_RULES === '0' ? [] : OTHER_AGENT_RULES.map((name) => ({ label: 'project', path: path.join(workspace, name) }))),
    ...await configInstructionFiles(workspace, env, options.home || env.HOME || os.homedir()),
    ...(env.OASIS_OTHER_AGENT_RULES === '0' ? [] : await aiderReadFiles(workspace, env, options.home || env.HOME || os.homedir())),
    ...(env.OASIS_OTHER_AGENT_RULES === '0' ? [] : (await geminiContextNames(workspace, env, options.home || env.HOME || os.homedir())).filter((name) => name !== 'GEMINI.md').flatMap((name) => [
      { label: 'user', path: path.join(options.home || env.HOME || os.homedir(), '.gemini', name) },
      { label: 'project', path: path.join(workspace, name) }
    ])),
    { label: 'local', path: path.join(workspace, 'OASIS.local.md') },
    { label: 'local', path: path.join(workspace, 'CLAUDE.local.md') },
    ...(env.OASIS_OTHER_AGENT_RULES === '0' ? [] : [{ label: 'local', path: path.join(workspace, 'AGENTS.local.md') }]),
    { label: 'readme', path: path.join(workspace, 'README.md') }
  ];
  const found = await Promise.all(candidates.map(async (item) => {
    try {
      const info = await lstat(item.path);
      return { ...item, exists: info.isFile() && info.size <= MAX_MEMORY_FILE * 4, size: info.size };
    } catch { return { ...item, exists: false }; }
  }));
  // Devin Desktop loads only .devin/global_rules.md when both it and the legacy
  // .windsurf/global_rules.md exist.
  const devinGlobal = found.find((item) => item.path === path.join(workspace, '.devin', 'global_rules.md'));
  if (devinGlobal && devinGlobal.exists) for (const item of found) if (item.path === path.join(workspace, '.windsurf', 'global_rules.md')) item.exists = false;
  // Roo Code reads the .roorules file only when .roo/rules/ has no rule files.
  const roorules = found.find((item) => item.path === path.join(workspace, '.roorules'));
  if (roorules && roorules.exists) {
    let names = [];
    try { names = await readdir(path.join(workspace, '.roo', 'rules'), { recursive: true }); } catch {}
    if (names.some((name) => /\.(?:md|txt)$/i.test(String(name)))) roorules.exists = false;
  }
  return found;
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
  if (content.length > LARGE_INSTRUCTION_FILE && content.length <= PER_FILE_LIMIT && notices) notices.push('Large ' + name + ' will use more context on every request (' + content.length.toLocaleString('en-US') + ' characters > ' + LARGE_INSTRUCTION_FILE.toLocaleString('en-US') + ').');
  if (content.length <= PER_FILE_LIMIT) return content;
  notices.push(name + ' is ' + content.length + ' characters; only the first ' + PER_FILE_LIMIT + ' were loaded into the prompt.');
  return content.slice(0, PER_FILE_LIMIT) + '\n[... ' + name + ' truncated: ' + (content.length - PER_FILE_LIMIT) + ' more characters not loaded. read_file it if the rest matters ...]';
}

export async function loadMemory(root, options = {}) {
  const excluded = excludeMatcher(options.excludes);
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
    if (excluded && file.label !== 'readme' && excluded(file.path, real)) continue;
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
    const block = '--- ' + heading + ': ' + name + ' ---\n' + (file.label === 'readme' ? clipReadme(readmeText(content)) : clipInstruction(name, content, notices));
    if (file.label === 'readme') readmePart = block;
    else parts.push(block);
  }
  const env = options.env || process.env;
  const rules = await projectRules(root, { env, notices, home: options.home, excludes: options.excludes });
  // Scoped instructions are deliberately excluded from base memory to keep the prompt small.
  const requested = [];
  for (const rule of rules) {
    if (rule.mode === 'scoped' || rule.mode === 'manual' || rule.mode === 'keyword' || seen.has(rule.real)) continue;
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
  const instructionTotal = parts.slice(0, readmePart ? -1 : undefined).join('\n\n').length;
  // One large file already has its own warning; the total one is for several.
  if (instructionTotal > LARGE_INSTRUCTION_TOTAL && instructionTotal <= MAX_TOTAL && parts.length - (readmePart ? 1 : 0) > 1) notices.push('Instruction files will use more context on every request: ' + instructionTotal.toLocaleString('en-US') + ' characters in total > ' + LARGE_INSTRUCTION_TOTAL.toLocaleString('en-US') + '.');
  if (joined.length <= MAX_TOTAL) return joined;
  const marker = '\n[... instruction budget of ' + MAX_TOTAL + ' characters reached: ' + (joined.length - MAX_TOTAL) + ' characters of the files above were not loaded ...]';
  const instructionsOnly = parts.slice(0, readmePart ? -1 : undefined).join('\n\n');
  if (instructionsOnly.length > MAX_TOTAL - marker.length) notices.push('Instruction files total ' + instructionsOnly.length + ' characters; only the first ' + MAX_TOTAL + ' were loaded.');
  return joined.slice(0, MAX_TOTAL - marker.length) + marker;
}

export function clipReadme(text, limit = README_LIMIT) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'));
  return (end > limit * 0.6 ? cut.slice(0, end) : cut.replace(/\s+\S*$/, '')).trimEnd() + '\n[README continues (' + text.length + ' characters in all); read_file README.md for the rest]';
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
const OTHER_AGENT_RULE_DIRS = [
  { dir: '.cursor/rules', ext: ['.mdc', '.md'], tool: 'Cursor' },
  { dir: '.devin/rules', ext: ['.md'], tool: 'Devin Desktop' },
  { dir: '.windsurf/rules', ext: ['.md'], tool: 'Windsurf' },
  { dir: '.agent/rules', ext: ['.md'], tool: 'Antigravity' },
  { dir: '.agents/rules', ext: ['.md'], tool: 'Antigravity' },
  { dir: '.github/instructions', ext: ['.instructions.md'], tool: 'Copilot' },
  { dir: '.kiro/steering', ext: ['.md'], tool: 'Kiro' },
  { dir: '.clinerules', ext: ['.md', '.txt'], tool: 'Cline' },
  { dir: '.roo/rules', ext: ['.md', '.txt'], tool: 'Roo Code' },
  { dir: '.kilocode/rules', ext: ['.md', '.txt'], tool: 'Kilo Code' },
  // OpenHands: always-on repository context (no triggers), path rules (paths:) and
  // keyword-triggered knowledge (triggers:). SKILL.md folders are skills, not rules.
  { dir: '.openhands/microagents', ext: ['.md'], tool: 'OpenHands', openhands: true },
  { dir: '.openhands/skills', ext: ['.md'], tool: 'OpenHands', openhands: true }
];

export async function projectRules(root, { env = process.env, notices = null, home = null, excludes = null } = {}) {
  const workspace = path.resolve(root);
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home || env.HOME || os.homedir(), '.claude');
  const rules = [
    ...await loadRules(path.join(claudeHome, 'rules'), 'user', null, notices),
    ...await loadRules(path.join(workspace, '.claude', 'rules'), 'project', workspace, notices, { prefix: '.claude/rules/' })
  ];
  if (env.OASIS_OTHER_AGENT_RULES !== '0') {
    // Devin Desktop personal rules (~/.devin/rules/*.md) apply to every project.
    rules.push(...await loadRules(path.join(home || env.HOME || os.homedir(), '.devin', 'rules'), 'user', null, notices, { prefix: '~/.devin/rules/' }));
    // Roo Code global rules (~/.roo/rules), for every project and mode.
    rules.push(...await loadRules(path.join(home || env.HOME || os.homedir(), '.roo', 'rules'), 'user', null, notices, { ext: ['.md', '.txt'], prefix: '~/.roo/rules/' }));
    // Antigravity CLI global rules and the rules of installed Antigravity CLI plugins.
    const antigravityCli = path.join(home || env.HOME || os.homedir(), '.gemini', 'antigravity-cli');
    rules.push(...await loadRules(path.join(antigravityCli, 'rules'), 'user', null, notices, { prefix: '~/.gemini/antigravity-cli/rules/' }));
    let plugins = [];
    try { plugins = (await readdir(path.join(antigravityCli, 'plugins'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().slice(0, 40); } catch {}
    for (const plugin of plugins) rules.push(...await loadRules(path.join(antigravityCli, 'plugins', plugin, 'rules'), 'user', null, notices, { prefix: '~/.gemini/antigravity-cli/plugins/' + plugin + '/rules/' }));
    // OpenHands user skills and legacy microagents (~/.openhands/skills, ~/.openhands/microagents).
    for (const dir of ['skills', 'microagents']) rules.push(...await loadRules(path.join(home || env.HOME || os.homedir(), '.openhands', dir), 'user', null, notices, { prefix: '~/.openhands/' + dir + '/', openhands: true }));
    for (const spec of OTHER_AGENT_RULE_DIRS) rules.push(...await loadRules(path.join(workspace, ...spec.dir.split('/')), 'project', workspace, notices, { ext: spec.ext, prefix: spec.dir + '/', openhands: spec.openhands }));
  }
  const excluded = excludeMatcher(excludes);
  return excluded ? rules.filter((rule) => !excluded(rule.file, rule.real)) : rules;
}

async function loadRules(dir, scope, workspace = null, notices = null, { ext = ['.md'], prefix = '', openhands = false } = {}) {
  const out = [];
  try { if (!(await lstat(dir)).isDirectory()) return out; } catch { return out; }
  const walk = async (current, depth) => {
    if (depth > 4 || out.length >= 60) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    // OpenHands skips README.md and SKILL.md folders (those are Agent Skills).
    if (openhands && depth > 0 && entries.some((entry) => entry.name.toLowerCase() === 'skill.md')) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (openhands && ['readme.md', 'skill.md'].includes(entry.name.toLowerCase())) continue;
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
          const { paths, body, mode, description, triggers, inputs } = splitRuleFrontMatter(text, path.basename(entry.name, path.extname(entry.name)));
          const name = path.relative(dir, full).split(path.sep).join('/');
          out.push({ scope, real, file: full, name, label: (prefix || (scope === 'user' ? '~/.claude/rules/' : '.claude/rules/')) + name, paths, mode, description, ...(triggers ? { triggers } : {}), ...(inputs && inputs.length ? { inputs } : {}), body: workspace ? await readImports(workspace, body) : body });
        } catch {}
      }
    }
  };
  await walk(dir, 0);
  return out;
}

const listOf = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map((item) => String(item).trim()).filter(Boolean);

// OpenHands task microagents: `inputs: [{ name, description }]` plus any ${VAR} in the
// body. OpenHands appends a request to ask for them; OASIS lists them as well.
function taskInputs(declared, body) {
  const out = [];
  const add = (name, description = '') => {
    const key = String(name || '').trim();
    if (/^[A-Za-z_][\w-]{0,63}$/.test(key) && !out.some((item) => item.name === key) && out.length < 20) out.push({ name: key, description: String(description || '').trim().slice(0, 300) });
  };
  for (const item of Array.isArray(declared) ? declared : []) {
    if (item && typeof item === 'object') add(item.name, item.description);
    else add(item);
  }
  for (const match of String(body || '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) add(match[1]);
  return out;
}

// Front matter of Claude (paths), Cursor (alwaysApply, globs, description), Windsurf and
// Antigravity (trigger: always_on | glob | model_decision | manual, globs), Copilot
// (applyTo), Kiro (inclusion: always | fileMatch | manual, fileMatchPattern) and
// OpenHands (triggers: [keywords]; inputs: adds the /name keyword; paths: wins over both).
function splitRuleFrontMatter(text, stem = '') {
  const { data: f, body, hasFrontMatter } = parseFrontMatter(text);
  if (!hasFrontMatter) return { paths: [], body: text, mode: 'always', description: '' };
  const description = typeof f.description === 'string' ? f.description.slice(0, 300) : '';
  let paths = [...listOf(f.paths), ...listOf(f.globs), ...listOf(f.applyto), ...listOf(f.filematchpattern)];
  const trigger = String(f.trigger || f.inclusion || '').toLowerCase().replace(/[\s-]/g, '_');
  let mode;
  if (String(f.alwaysapply).toLowerCase() === 'true' || ['always_on', 'always'].includes(trigger)) { mode = 'always'; paths = []; }
  else if (['manual'].includes(trigger)) mode = 'manual';
  else if (['model_decision', 'agent_requested', 'auto'].includes(trigger) && !paths.length) mode = 'requested';
  else if (paths.length) mode = 'scoped';
  else if (Array.isArray(f.triggers) && f.triggers.length || f.inputs !== undefined) {
    const triggers = (Array.isArray(f.triggers) ? f.triggers : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 40);
    if (f.inputs !== undefined) {
      const slash = '/' + (typeof f.name === 'string' && f.name.trim() ? f.name.trim() : stem);
      if (!triggers.includes(slash)) triggers.push(slash);
    }
    return { paths: [], body, mode: 'keyword', description, triggers, inputs: taskInputs(f.inputs, body) };
  }
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
// AGENT.md and AGENTS.local.md are read per directory by Devin Desktop.
const NESTED_NAMES = ['CLAUDE.md', 'AGENTS.md', 'OASIS.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md'), 'AGENT.md', 'AGENTS.local.md'];
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
  const excluded = excludeMatcher(options.excludes);
  // Nested AGENTS.md files are rules for the directory being edited; 12,000
  // characters cut ordinary ones short.
  let budget = options.maxChars || 100_000;
  // Gemini CLI loads its context files (GEMINI.md or context.fileName) just in time too.
  const nestedNames = env.OASIS_OTHER_AGENT_RULES === '0' ? NESTED_NAMES : [...new Set([...NESTED_NAMES, '.goosehints', ...(parts.length ? await geminiContextNames(workspace, env, options.home || env.HOME || os.homedir()) : [])])];
  for (let i = 1; i <= parts.length; i++) {
    const dir = path.join(workspace, ...parts.slice(0, i));
    if (/(^|\/)(node_modules|\.git)(\/|$)/.test(dir)) break;
    for (const name of nestedNames) {
      const file = path.join(dir, name);
      if (loaded.has(file)) continue;
      try {
        const info = await lstat(file);
        if (!info.isFile()) continue;
        const real = await realpath(file);
        const back = path.relative(workspace, real);
        if (back.startsWith('..') || path.isAbsolute(back)) continue;
        loaded.add(file);
        if (excluded && excluded(file, real)) continue;
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
  const scoped = (await projectRules(workspace, { env, home: options.home, excludes: options.excludes }))
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

// OpenHands keyword matching (behaviour of _keyword_matches in OpenHands
// software-agent-sdk skills/skill.py, MIT): whole token, case-insensitive, bounded by
// non-alphanumerics, so "git" does not fire on "github" but "/linear" works.
export function keywordMatches(keyword, message) {
  const word = String(keyword || '').toLowerCase();
  if (!word) return false;
  return new RegExp('(?<![a-z0-9])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])').test(String(message || '').toLowerCase());
}

/**
 * Keyword-triggered rules (OpenHands knowledge microagents and skills with
 * "triggers:") that the message mentions, formatted the way OpenHands adds them
 * to the user message. `alreadyLoaded(label)` skips rules sent earlier in the
 * conversation, as OpenHands does with skip_skill_names.
 */
export async function keywordRulesFor(root, message, options = {}) {
  const env = options.env || process.env;
  const text = String(message || '').trim();
  if (!text || env.OASIS_OTHER_AGENT_RULES === '0') return { text: '', labels: [] };
  const alreadyLoaded = typeof options.alreadyLoaded === 'function' ? options.alreadyLoaded : () => false;
  const blocks = [];
  const labels = [];
  let budget = 20000;
  for (const rule of await projectRules(root, { env, home: options.home })) {
    if (rule.mode !== 'keyword' || labels.includes(rule.label) || alreadyLoaded(rule.label)) continue;
    const trigger = rule.triggers.find((keyword) => keywordMatches(keyword, text));
    if (!trigger) continue;
    let body = cleanInstructionText('rule ' + rule.label, rule.body, null).slice(0, Math.min(PER_FILE_LIMIT, budget));
    if (!body.trim()) continue;
    if (rule.inputs && rule.inputs.length) {
      body = body.trimEnd() + '\n\nInputs this task needs:\n' + rule.inputs.map((item) => '- ' + item.name + (item.description ? ': ' + item.description : '')).join('\n') +
        "\n\nIf the user didn't provide any of these variables, ask the user to provide them first (with ask_user_question when it is available) before the agent can proceed with the task.";
    }
    budget -= body.length;
    labels.push(rule.label);
    blocks.push('<EXTRA_INFO>\nThe following information has been included based on a keyword match for "' + trigger + '".\nIt may or may not be relevant to the user\'s request.\nSkill location: ' + rule.label + '\n\n' + body.trim() + '\n</EXTRA_INFO>');
    if (budget <= 0) break;
  }
  // SKILL.md files with `triggers:` (OpenHands AgentSkills) are added the same way.
  if (budget > 0) {
    let skills = [];
    const tools = await import('./tools.mjs');
    try { skills = await tools.listAvailableSkills(root, { env }); } catch { skills = []; }
    for (const skill of skills) {
      if (budget <= 0) break;
      if (!Array.isArray(skill.triggers) || !skill.triggers.length || skill.source === 'built-in') continue;
      // The label is the Skill location line, which is how a later turn sees it was sent.
      const label = tools.skillLocation(root, skill).path || 'skill ' + skill.name;
      if (labels.includes(label) || alreadyLoaded(label)) continue;
      const trigger = skill.triggers.find((keyword) => keywordMatches(keyword, text));
      if (!trigger) continue;
      let content = '';
      try { content = (await tools.loadSkillText(root, skill.name, { env })).content; } catch { continue; }
      const body = cleanInstructionText('skill ' + skill.name, parseFrontMatter(content).body, null).slice(0, Math.min(PER_FILE_LIMIT, budget));
      if (!body.trim()) continue;
      budget -= body.length;
      labels.push(label);
      blocks.push('<EXTRA_INFO>\nThe following information has been included based on a keyword match for "' + trigger + '".\nIt may or may not be relevant to the user\'s request.\nSkill location: ' + label + '\n\n' + body.trim() + '\n</EXTRA_INFO>');
    }
  }
  return { text: blocks.join('\n'), labels };
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

async function claudeAutoMemoryBlock(root, { env = process.env, home, notices = [] } = {}) {
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
