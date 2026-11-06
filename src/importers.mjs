// `oasis import` / `/import`: bring configuration over from OpenAI Codex, Google Gemini CLI
// and Cursor, like Claude Code's /import. Nothing is overwritten: items whose target already
// exists are reported as skipped.
//
//   Codex   ~/.codex/config.toml [mcp_servers.*]   -> user MCP servers (<oasis config>/mcp.json)
//           ~/.codex/AGENTS.md                      -> user instructions (<oasis config>/OASIS.md)
//           ~/.codex/prompts/*.md                   -> user commands
//   Gemini  ~/.gemini/settings.json mcpServers      -> user MCP servers
//           .gemini/settings.json mcpServers        -> project .mcp.json
//           ~/.gemini/GEMINI.md                     -> user instructions
//           GEMINI.md                               -> .claude/rules/gemini.md
//           ~/.gemini/commands/**/*.toml            -> user commands ({{args}} -> $ARGUMENTS)
//           .gemini/commands/**/*.toml              -> project commands (.oasis/commands)
//   Cursor  ~/.cursor/mcp.json                      -> user MCP servers
//           .cursor/mcp.json                        -> project .mcp.json
//           .cursorrules, .cursor/rules/**/*.mdc    -> .claude/rules/ (globs -> paths)
//           .cursor/commands/*.md                   -> project commands
//   Claude  ~/.claude/projects/<this repo>/memory/*.md -> OASIS project memories
//   Hermes  ~/.hermes/config.yaml mcp_servers       -> user MCP servers
//           memories/MEMORY.md, USER.md             -> OASIS user memories
//           SOUL.md                                 -> user instructions
//           skills/**/SKILL.md                      -> user skills (~/.config/agents/skills)
//           .hermes.md / HERMES.md                  -> .claude/rules/hermes.md
//   OpenCode opencode.json(c) mcp / command          -> MCP servers and commands (user and project)
//           .opencode/commands, agents, skills      -> project commands, .claude/agents, .oasis/skills
//           ~/.config/opencode/commands, skills     -> user commands and skills
//   Antigravity ~/.gemini/config|antigravity|antigravity-cli: mcp_config.json, skills/, rules/, workflows/
//           .agents/mcp_config.json, .agents/rules, .agent/rules, .agents/workflows
//   Windsurf ~/.codeium/windsurf/mcp_config.json, memories/global_rules.md
//           .windsurfrules, .windsurf/rules/*.md, .windsurf/workflows/*.md
//   Cline   cline_mcp_settings.json (VS Code global storage), ~/Documents/Cline/Rules
//           .clinerules (file or folder), .clinerules/workflows/*.md
//   Codex also: ~/.codex/memories/*.md -> user memories, ~/.codex/skills -> user skills
import { mkdir, readFile, readdir, writeFile, lstat, rename, unlink, cp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { parse as parseTomlText } from 'smol-toml';
import { parse as parseYamlText } from 'yaml';
import { parse as parseJsoncText, printParseErrorCode } from 'jsonc-parser';
import { parseYamlMapping, splitFrontMatter } from './frontmatter.mjs';

export const IMPORT_SOURCES = ['codex', 'gemini', 'cursor', 'claude', 'hermes', 'opencode', 'antigravity', 'windsurf', 'cline'];
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const MAX_FILE = 256 * 1024;

// TOML (Codex config, Gemini commands), JSONC (OpenCode) and YAML (Hermes config, rule and
// agent front matter) are parsed by smol-toml, Microsoft's jsonc-parser and yaml.
/** TOML 1.0. Throws an Error whose message starts with "TOML:". */
export function parseToml(text) {
  // smol-toml builds null-prototype objects; callers get ordinary ones.
  const plain = (value) => Array.isArray(value) ? value.map(plain)
    : value && typeof value === 'object' && !(value instanceof Date) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)])) : value;
  try { return plain(parseTomlText(String(text))); } catch (error) { throw new Error('TOML: ' + String(error && error.message || error).split('\n')[0]); }
}

/** A YAML config file (Hermes config.yaml) as a mapping with typed scalars. Throws on a syntax error. */
export function parseYamlSubset(text) {
  const value = parseYamlText(String(text), { schema: 'core', maxAliasCount: 100, prettyErrors: false });
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Typed front matter (core schema) and the body after it. */
function typedFrontMatter(text) {
  const { metadata, body, hasFrontMatter } = splitFrontMatter(String(text).replace(/\r\n/g, '\n'));
  return { meta: hasFrontMatter ? parseYamlMapping(metadata, { schema: 'core' }) : {}, body, hasFrontMatter };
}

/** JSON with comments and trailing commas (opencode.jsonc). Throws on a syntax error. */
export function parseJsonc(text) {
  const errors = [];
  const value = parseJsoncText(String(text), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new SyntaxError('JSONC: ' + printParseErrorCode(errors[0].error) + ' at offset ' + errors[0].offset);
  return value;
}

// ---- helpers ----
async function readText(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_FILE) return null;
    return await readFile(file, 'utf8');
  } catch { return null; }
}
async function readJson(file) {
  const text = await readText(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}
async function exists(file) { try { await lstat(file); return true; } catch { return false; } }
async function listFiles(dir, ext, depth = 3, prefix = []) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && depth > 0 && !entry.name.startsWith('.')) out.push(...await listFiles(path.join(dir, entry.name), ext, depth - 1, [...prefix, entry.name]));
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push({ file: path.join(dir, entry.name), parts: [...prefix, entry.name.slice(0, -ext.length)] });
  }
  return out;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
const serverName = (s) => { const n = String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 40); return n || 'server'; };

function normalizeServer(raw, flavor) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.enabled === false || raw.disabled === true) return null;
  const out = {};
  if (flavor === 'opencode') {
    if (raw.type === 'remote' && raw.url) return { type: 'http', url: String(raw.url), ...(raw.headers ? { headers: { ...raw.headers } } : {}) };
    const argv = Array.isArray(raw.command) ? raw.command.map(String) : raw.command ? [String(raw.command)] : [];
    if (!argv.length) return null;
    const local = { command: argv[0] };
    if (argv.length > 1) local.args = argv.slice(1);
    if (raw.environment && typeof raw.environment === 'object') local.env = Object.fromEntries(Object.entries(raw.environment).map(([k, v]) => [k, String(v).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')]));
    if (raw.cwd) local.cwd = String(raw.cwd);
    return local;
  }
  const url = flavor === 'gemini' ? (raw.httpUrl || raw.url) : (raw.url || raw.serverUrl);
  if (url) {
    out.type = flavor === 'gemini' && raw.url && !raw.httpUrl ? 'sse' : 'http';
    out.url = String(url);
    const headers = { ...(raw.headers || raw.http_headers || {}) };
    if (raw.bearer_token_env_var) headers.Authorization = 'Bearer ${' + raw.bearer_token_env_var + '}';
    if (raw.env_http_headers) for (const [k, v] of Object.entries(raw.env_http_headers)) headers[k] = '${' + v + '}';
    if (Object.keys(headers).length) out.headers = headers;
  } else if (raw.command) {
    out.command = String(raw.command);
    if (Array.isArray(raw.args)) out.args = raw.args.map(String);
    if (raw.env && typeof raw.env === 'object') out.env = Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]));
    if (raw.cwd) out.cwd = String(raw.cwd);
  } else return null;
  return out;
}

export function geminiCommandToMarkdown(toml) {
  const data = parseToml(toml);
  if (typeof data.prompt !== 'string') return null;
  let body = data.prompt
    .replace(/\{\{\s*args\s*\}\}/g, '$ARGUMENTS')
    .replace(/!\{([^}]*)\}/g, (m, cmd) => '!`' + cmd.trim() + '`')
    .replace(/@\{([^}]*)\}/g, (m, p) => '@' + p.trim());
  if (!/\$ARGUMENTS/.test(body)) body = body.trimEnd() + '\n\n$ARGUMENTS';
  const front = data.description ? '---\ndescription: ' + JSON.stringify(String(data.description)) + '\n---\n\n' : '';
  return front + body.trim() + '\n';
}

function cursorRuleToMarkdown(text, name) {
  const { meta, body: rest } = typedFrontMatter(text);
  const body = rest.trim();
  const lines = ['---'];
  if (meta.description) lines.push('description: ' + JSON.stringify(String(meta.description)));
  // Cursor writes `globs: src/**/*.ts, test/**` unquoted as well as YAML lists.
  let globs = (Array.isArray(meta.globs) ? meta.globs : String(meta.globs || '').split(',')).map((g) => String(g).trim()).filter(Boolean);
  if (meta.alwaysApply === true || String(meta.alwaysApply) === 'true') globs = [];
  if (globs.length) { lines.push('paths:'); for (const g of globs) lines.push('  - ' + JSON.stringify(g)); }
  lines.push('---', '', '<!-- imported from Cursor rule ' + name + ' -->', body, '');
  return (lines.length > 3 ? lines.join('\n') : lines.slice(2).join('\n'));
}

/** Antigravity / Windsurf rule frontmatter (trigger: always_on | glob | model_decision | manual). */
function triggerRuleToMarkdown(text, origin) {
  const { meta, body: rest } = typedFrontMatter(text);
  const body = rest.trim();
  if (String(meta.trigger || '').replace(/-/g, '_') === 'manual') return null;
  const lines = ['---'];
  if (meta.description) lines.push('description: ' + JSON.stringify(String(meta.description)));
  const globs = String(meta.trigger || '') === 'glob' ? (Array.isArray(meta.globs) ? meta.globs : String(meta.globs || '').split(',')).map((g) => String(g).trim()).filter(Boolean) : [];
  if (globs.length) { lines.push('paths:'); for (const g of globs) lines.push('  - ' + JSON.stringify(g)); }
  lines.push('---', '');
  return (lines.length > 3 ? lines.join('\n') : '') + '<!-- imported from ' + origin + ' -->\n' + body + '\n';
}

/** OpenCode agent markdown -> Claude-style subagent markdown. */
function opencodeAgentToMarkdown(text, name) {
  const { meta, body: rest } = typedFrontMatter(text);
  const body = rest.trim();
  const lines = ['---', 'name: ' + name, 'description: ' + JSON.stringify(String(meta.description || 'Imported from OpenCode agent ' + name))];
  if (meta.tools && typeof meta.tools === 'object' && !Array.isArray(meta.tools)) {
    const map = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', glob: 'Glob', webfetch: 'WebFetch', list: 'LS' };
    const allowed = Object.entries(meta.tools).filter(([, on]) => on === true).map(([tool]) => map[tool]).filter(Boolean);
    if (allowed.length) lines.push('tools: ' + allowed.join(', '));
  }
  lines.push('---', '', body, '');
  return lines.join('\n');
}

/** Split a Hermes MEMORY.md / USER.md into entries ("§" separated, or blank-line paragraphs). */
export function splitMemoryEntries(text) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/^#.*\n/gm, '');
  const parts = src.includes('§') ? src.split(/\n?§\n?/) : src.split(/\n\s*\n/);
  return parts.map((part) => part.trim()).filter((part) => part.length >= 8).slice(0, 200);
}

function isWithinPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

// Import plans can be stale by the time the user confirms them. Re-check the
// destination at apply time, including every existing parent directory.
async function assertSafeImportTarget(plan, rawTarget) {
  if (typeof rawTarget !== 'string' || !rawTarget) throw new Error('Import destination is missing.');
  const target = path.resolve(rawTarget);
  const workspace = path.resolve(plan.root);
  const userConfig = path.resolve(path.dirname(plan.userMcpFile));
  const userSkills = plan.userSkillsDir ? path.resolve(plan.userSkillsDir) : null;
  const base = isWithinPath(workspace, target) ? workspace :
    (isWithinPath(userConfig, target) ? userConfig : (userSkills && isWithinPath(userSkills, target) ? userSkills : null));
  if (!base) throw new Error('Import destination must remain inside the workspace or user OASIS configuration directory.');

  const relative = path.relative(base, target);
  const parent = path.dirname(relative);
  let current = base;
  for (const part of parent === '.' ? [] : parent.split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Refusing to import through a symbolic-link directory: ' + current);
      if (!info.isDirectory()) throw new Error('Import destination parent is not a directory: ' + current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(plan.allowDirectoryTarget ? 'Import destination already exists: ' + target : 'Refusing to import to a non-regular or symbolic-link destination: ' + target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function writeImportFileAtomically(file, content, mode) {
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

function importItemTarget(plan, item) {
  if (item.kind === 'mcp') {
    if (item.scope === 'user') return plan.userMcpFile;
    if (item.scope === 'project') return plan.projectMcpFile;
    throw new Error('Invalid MCP import scope.');
  }
  return item.target;
}

// ---- planning ----
export async function planImport(root, options = {}) {
  const env = options.env || process.env;
  const home = options.home || env.HOME || env.USERPROFILE || os.homedir();
  const configDir = getConfigDirectory(env, home);
  const workspace = path.resolve(root);
  const sources = options.sources && options.sources.length ? options.sources : IMPORT_SOURCES;
  const items = [];
  const userMcpFile = path.join(configDir, 'mcp.json');
  const projectMcpFile = path.join(workspace, '.mcp.json');
  const userMcp = (await readJson(userMcpFile)) || {};
  const projectMcp = (await readJson(projectMcpFile)) || {};
  const knownUser = new Set(Object.keys(userMcp.mcpServers || {}));
  const knownProject = new Set(Object.keys(projectMcp.mcpServers || {}));
  const userMemory = path.join(configDir, 'OASIS.md');
  const userMemoryText = (await readText(userMemory)) || '';

  const addServers = (servers, source, scope, flavor) => {
    for (const [rawName, raw] of Object.entries(servers || {})) {
      const name = serverName(rawName);
      const server = normalizeServer(raw, flavor);
      const known = scope === 'user' ? knownUser : knownProject;
      if (!server) { items.push({ kind: 'mcp', source, scope, name, action: 'skip', reason: 'disabled or unsupported entry' }); continue; }
      if (known.has(name)) { items.push({ kind: 'mcp', source, scope, name, action: 'skip', reason: 'already configured' }); continue; }
      known.add(name);
      items.push({ kind: 'mcp', source, scope, name, action: 'add', target: scope === 'user' ? userMcpFile : projectMcpFile, server });
    }
  };
  const addFile = async (kind, source, from, target, content, name) => {
    if (content === null || content === undefined) return;
    if (await exists(target)) { items.push({ kind, source, name, from, target, action: 'skip', reason: 'target exists' }); return; }
    if (items.some((item) => item.target === target && item.action === 'add')) { items.push({ kind, source, name, from, target, action: 'skip', reason: 'duplicate name' }); return; }
    items.push({ kind, source, name, from, target, action: 'add', content });
  };
  const userSkillsDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agents', 'skills');
  const { listMemories } = await import('./auto-memory.mjs');
  const knownMemories = new Set();
  try { for (const memory of await listMemories(workspace, { env: { ...env, OASIS_CONFIG_DIR: configDir } })) knownMemories.add(memory.scope + ':' + String(memory.name).toLowerCase()); } catch {}
  const addMemory = (source, from, scope, name, content, category) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean || !String(content || '').trim()) return;
    const key = scope + ':' + clean.toLowerCase();
    if (knownMemories.has(key)) { items.push({ kind: 'memory', source, scope, name: clean, from, action: 'skip', reason: 'already in memory' }); return; }
    knownMemories.add(key);
    items.push({ kind: 'memory', source, scope, name: clean, from, action: 'add', category, content: String(content).trim().slice(0, 8000) });
  };
  const addSkills = async (source, dir, targetDir, depth = 0) => {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const from = path.join(dir, entry.name);
      if (await exists(path.join(from, 'SKILL.md'))) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(entry.name)) { items.push({ kind: 'skill', source, name: entry.name, from, action: 'skip', reason: 'unsupported skill folder name' }); continue; }
        const target = path.join(targetDir, entry.name);
        if (await exists(target)) items.push({ kind: 'skill', source, name: entry.name, from, target, action: 'skip', reason: 'target exists' });
        else if (items.some((item) => item.target === target && item.action === 'add')) items.push({ kind: 'skill', source, name: entry.name, from, target, action: 'skip', reason: 'duplicate name' });
        else items.push({ kind: 'skill', source, name: entry.name, from, target, action: 'add' });
      } else if (depth > 0) await addSkills(source, from, targetDir, depth - 1);
    }
  };
  const addMarkdownCommands = async (source, dir, targetDir, scope) => {
    for (const { file, parts } of await listFiles(dir, '.md')) {
      await addFile('command', source, file, path.join(targetDir, ...parts.slice(0, -1).map(slug), slug(parts[parts.length - 1]) + '.md'), await readText(file), parts.join(':') + (scope ? ' (' + scope + ')' : ''));
    }
  };
  const addTriggerRules = async (source, dir, prefix) => {
    for (const { file, parts } of await listFiles(dir, '.md', 0)) {
      const text = await readText(file);
      if (!text) continue;
      const converted = triggerRuleToMarkdown(text, path.relative(workspace, file) || file);
      if (converted === null) { items.push({ kind: 'rule', source, name: parts.join('/'), from: file, action: 'skip', reason: 'manual rule (only applies when @-mentioned)' }); continue; }
      await addFile('rule', source, file, path.join(workspace, '.claude', 'rules', prefix + slug(parts.join('-')) + '.md'), converted, parts.join('/'));
    }
  };
  const addInstructions = (source, from, text) => {
    if (!text || !text.trim()) return;
    const marker = '<!-- imported from ' + source + ': ' + from + ' -->';
    if (userMemoryText.includes(marker)) { items.push({ kind: 'instructions', source, name: path.basename(from), from, target: userMemory, action: 'skip', reason: 'already imported' }); return; }
    items.push({ kind: 'instructions', source, name: path.basename(from), from, target: userMemory, action: 'append', content: '\n' + marker + '\n' + text.trim() + '\n' });
  };

  if (sources.includes('codex')) {
    const codexHome = env.CODEX_HOME || path.join(home, '.codex');
    const tomlText = await readText(path.join(codexHome, 'config.toml'));
    if (tomlText) {
      try { addServers(parseToml(tomlText).mcp_servers, 'codex', 'user', 'codex'); } catch (error) { items.push({ kind: 'mcp', source: 'codex', name: 'config.toml', action: 'skip', reason: 'could not parse: ' + error.message }); }
    }
    const agents = path.join(codexHome, 'AGENTS.md');
    addInstructions('codex', agents, await readText(agents));
    for (const { file, parts } of await listFiles(path.join(codexHome, 'prompts'), '.md', 0)) {
      await addFile('command', 'codex', file, path.join(configDir, 'commands', slug(parts.join('-')) + '.md'), await readText(file), parts.join(':'));
    }
    for (const { file, parts } of await listFiles(path.join(codexHome, 'memories'), '.md', 1)) {
      if (/^(memory_summary|index)$/i.test(parts[parts.length - 1])) continue;
      addMemory('codex', file, 'user', 'Codex: ' + parts.join(' / ').replace(/[-_]+/g, ' '), await readText(file), 'reference');
    }
    await addSkills('codex', path.join(codexHome, 'skills'), userSkillsDir);
  }
  if (sources.includes('gemini')) {
    const geminiHome = path.join(home, '.gemini');
    addServers(((await readJson(path.join(geminiHome, 'settings.json'))) || {}).mcpServers, 'gemini', 'user', 'gemini');
    addServers(((await readJson(path.join(workspace, '.gemini', 'settings.json'))) || {}).mcpServers, 'gemini', 'project', 'gemini');
    const userGemini = path.join(geminiHome, 'GEMINI.md');
    addInstructions('gemini', userGemini, await readText(userGemini));
    const projectGemini = await readText(path.join(workspace, 'GEMINI.md'));
    if (projectGemini) await addFile('rule', 'gemini', path.join(workspace, 'GEMINI.md'), path.join(workspace, '.claude', 'rules', 'gemini.md'), '<!-- imported from GEMINI.md -->\n' + projectGemini.trim() + '\n', 'GEMINI.md');
    for (const [dir, targetDir, scope] of [[path.join(geminiHome, 'commands'), path.join(configDir, 'commands'), 'user'], [path.join(workspace, '.gemini', 'commands'), path.join(workspace, '.oasis', 'commands'), 'project']]) {
      for (const { file, parts } of await listFiles(dir, '.toml')) {
        let content = null;
        try { content = geminiCommandToMarkdown(await readText(file) || ''); } catch (error) { items.push({ kind: 'command', source: 'gemini', name: parts.join(':'), from: file, action: 'skip', reason: 'could not parse: ' + error.message }); continue; }
        if (!content) continue;
        await addFile('command', 'gemini', file, path.join(targetDir, ...parts.slice(0, -1).map(slug), slug(parts[parts.length - 1]) + '.md'), content, parts.join(':') + ' (' + scope + ')');
      }
    }
  }
  if (sources.includes('cursor')) {
    addServers(((await readJson(path.join(home, '.cursor', 'mcp.json'))) || {}).mcpServers, 'cursor', 'user', 'cursor');
    addServers(((await readJson(path.join(workspace, '.cursor', 'mcp.json'))) || {}).mcpServers, 'cursor', 'project', 'cursor');
    const legacy = await readText(path.join(workspace, '.cursorrules'));
    if (legacy) await addFile('rule', 'cursor', path.join(workspace, '.cursorrules'), path.join(workspace, '.claude', 'rules', 'cursorrules.md'), '<!-- imported from .cursorrules -->\n' + legacy.trim() + '\n', '.cursorrules');
    for (const { file, parts } of await listFiles(path.join(workspace, '.cursor', 'rules'), '.mdc')) {
      const text = await readText(file);
      if (text) await addFile('rule', 'cursor', file, path.join(workspace, '.claude', 'rules', 'cursor-' + slug(parts.join('-')) + '.md'), cursorRuleToMarkdown(text, parts.join('/')), parts.join('/'));
    }
    for (const { file, parts } of await listFiles(path.join(workspace, '.cursor', 'commands'), '.md')) {
      await addFile('command', 'cursor', file, path.join(workspace, '.oasis', 'commands', ...parts.slice(0, -1).map(slug), slug(parts[parts.length - 1]) + '.md'), await readText(file), parts.join(':'));
    }
  }
  if (sources.includes('claude')) {
    const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const variants = [...new Set([workspace.replace(/[^A-Za-z0-9]/g, '-'), workspace.replace(/[\\/]/g, '-'), workspace.replace(/[\\/.]/g, '-')])];
    for (const variant of variants) {
      const dir = path.join(claudeHome, 'projects', variant, 'memory');
      for (const { file, parts } of await listFiles(dir, '.md', 0)) {
        if (/^MEMORY$/i.test(parts[0])) continue;
        const text = await readText(file);
        if (!text) continue;
        const { meta, body } = typedFrontMatter(text);
        const type = String(meta.type || '').toLowerCase();
        const category = type === 'user' || type === 'feedback' ? 'preferences' : type === 'reference' ? 'reference' : 'project';
        addMemory('claude', file, 'project', String(meta.name || parts[0].replace(/[-_]+/g, ' ')), (meta.description ? meta.description + '\n\n' : '') + body, category);
      }
    }
  }
  if (sources.includes('hermes')) {
    const hermesHome = env.HERMES_HOME || path.join(home, '.hermes');
    const yamlText = await readText(path.join(hermesHome, 'config.yaml'));
    if (yamlText) {
      try { addServers((parseYamlSubset(yamlText) || {}).mcp_servers, 'hermes', 'user', 'hermes'); } catch (error) { items.push({ kind: 'mcp', source: 'hermes', name: 'config.yaml', action: 'skip', reason: 'could not parse: ' + error.message }); }
    }
    for (const [file, scope, category, label] of [[path.join(hermesHome, 'memories', 'MEMORY.md'), 'user', 'reference', 'Hermes memory'], [path.join(hermesHome, 'MEMORY.md'), 'user', 'reference', 'Hermes memory'], [path.join(hermesHome, 'memories', 'USER.md'), 'user', 'preferences', 'Hermes user profile'], [path.join(hermesHome, 'USER.md'), 'user', 'preferences', 'Hermes user profile']]) {
      const entries = splitMemoryEntries(await readText(file));
      entries.forEach((entry, index) => addMemory('hermes', file, scope, label + ' ' + (index + 1) + ': ' + entry.split('\n')[0].slice(0, 50), entry, category));
    }
    const soul = path.join(hermesHome, 'SOUL.md');
    addInstructions('hermes', soul, await readText(soul));
    await addSkills('hermes', path.join(hermesHome, 'skills'), userSkillsDir, 2);
    for (const name of ['.hermes.md', 'HERMES.md']) {
      const text = await readText(path.join(workspace, name));
      if (text) { await addFile('rule', 'hermes', path.join(workspace, name), path.join(workspace, '.claude', 'rules', 'hermes.md'), '<!-- imported from ' + name + ' -->\n' + text.trim() + '\n', name); break; }
    }
  }
  if (sources.includes('opencode')) {
    const globalDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
    const configs = [[path.join(globalDir, 'opencode.json'), 'user'], [path.join(globalDir, 'opencode.jsonc'), 'user'], [path.join(workspace, 'opencode.json'), 'project'], [path.join(workspace, 'opencode.jsonc'), 'project'], [path.join(workspace, '.opencode', 'opencode.json'), 'project'], [path.join(workspace, '.opencode', 'opencode.jsonc'), 'project']];
    for (const [file, scope] of configs) {
      const text = await readText(file);
      if (!text) continue;
      let data;
      try { data = parseJsonc(text); } catch (error) { items.push({ kind: 'mcp', source: 'opencode', name: path.basename(file), action: 'skip', reason: 'could not parse: ' + error.message }); continue; }
      const mcp = data && data.mcp || {};
      addServers(mcp.servers && typeof mcp.servers === 'object' ? mcp.servers : Object.fromEntries(Object.entries(mcp).filter(([, v]) => v && typeof v === 'object' && v.type)), 'opencode', scope, 'opencode');
      for (const [name, command] of Object.entries(data && data.command || {})) {
        if (!command || typeof command.template !== 'string') continue;
        const body = (command.description ? '---\ndescription: ' + JSON.stringify(String(command.description)) + '\n---\n\n' : '') + command.template.trim() + (command.template.includes('$ARGUMENTS') ? '' : '\n\n$ARGUMENTS') + '\n';
        await addFile('command', 'opencode', file, path.join(scope === 'user' ? path.join(configDir, 'commands') : path.join(workspace, '.oasis', 'commands'), slug(name) + '.md'), body, name + ' (' + scope + ')');
      }
    }
    for (const sub of ['commands', 'command']) {
      await addMarkdownCommands('opencode', path.join(globalDir, sub), path.join(configDir, 'commands'), 'user');
      await addMarkdownCommands('opencode', path.join(workspace, '.opencode', sub), path.join(workspace, '.oasis', 'commands'), 'project');
    }
    for (const sub of ['agents', 'agent']) {
      for (const { file, parts } of await listFiles(path.join(workspace, '.opencode', sub), '.md', 0)) {
        const text = await readText(file);
        if (text) await addFile('agent', 'opencode', file, path.join(workspace, '.claude', 'agents', slug(parts[0]) + '.md'), opencodeAgentToMarkdown(text, slug(parts[0])), parts[0]);
      }
    }
    await addSkills('opencode', path.join(globalDir, 'skills'), userSkillsDir);
    await addSkills('opencode', path.join(workspace, '.opencode', 'skills'), path.join(workspace, '.oasis', 'skills'));
  }
  if (sources.includes('antigravity')) {
    const gemini = path.join(home, '.gemini');
    for (const dir of [path.join(gemini, 'config'), path.join(gemini, 'antigravity'), path.join(gemini, 'antigravity-cli')]) {
      addServers(((await readJson(path.join(dir, 'mcp_config.json'))) || {}).mcpServers, 'antigravity', 'user', 'antigravity');
      await addSkills('antigravity', path.join(dir, 'skills'), userSkillsDir);
      for (const { file, parts } of await listFiles(path.join(dir, 'rules'), '.md', 0)) {
        const text = await readText(file);
        const converted = text && triggerRuleToMarkdown(text, file);
        if (converted) addInstructions('antigravity', file, converted.replace(/^---[\s\S]*?---\n\n?/, ''));
        else if (text) items.push({ kind: 'rule', source: 'antigravity', name: parts[0], from: file, action: 'skip', reason: 'manual rule (only applies when @-mentioned)' });
      }
      for (const wf of ['workflows', 'global_workflows']) await addMarkdownCommands('antigravity', path.join(dir, wf), path.join(configDir, 'commands'), 'user');
    }
    for (const name of ['AGENTS.md', 'GEMINI.md']) { const file = path.join(gemini, 'config', name); addInstructions('antigravity', file, await readText(file)); }
    await addSkills('antigravity', path.join(gemini, 'skills'), userSkillsDir);
    addServers(((await readJson(path.join(workspace, '.agents', 'mcp_config.json'))) || {}).mcpServers, 'antigravity', 'project', 'antigravity');
    await addTriggerRules('antigravity', path.join(workspace, '.agents', 'rules'), 'antigravity-');
    await addTriggerRules('antigravity', path.join(workspace, '.agent', 'rules'), 'antigravity-');
    await addSkills('antigravity', path.join(workspace, '.agent', 'skills'), path.join(workspace, '.agents', 'skills'));
    for (const dir of ['.agents', '.agent']) await addMarkdownCommands('antigravity', path.join(workspace, dir, 'workflows'), path.join(workspace, '.oasis', 'commands'), 'project');
  }
  if (sources.includes('windsurf')) {
    const windsurf = path.join(home, '.codeium', 'windsurf');
    addServers(((await readJson(path.join(windsurf, 'mcp_config.json'))) || {}).mcpServers, 'windsurf', 'user', 'windsurf');
    const globalRules = path.join(windsurf, 'memories', 'global_rules.md');
    addInstructions('windsurf', globalRules, await readText(globalRules));
    const legacy = await readText(path.join(workspace, '.windsurfrules'));
    if (legacy) await addFile('rule', 'windsurf', path.join(workspace, '.windsurfrules'), path.join(workspace, '.claude', 'rules', 'windsurfrules.md'), '<!-- imported from .windsurfrules -->\n' + legacy.trim() + '\n', '.windsurfrules');
    await addTriggerRules('windsurf', path.join(workspace, '.windsurf', 'rules'), 'windsurf-');
    await addMarkdownCommands('windsurf', path.join(workspace, '.windsurf', 'workflows'), path.join(workspace, '.oasis', 'commands'), 'project');
    await addMarkdownCommands('windsurf', path.join(windsurf, 'global_workflows'), path.join(configDir, 'commands'), 'user');
  }
  if (sources.includes('cline')) {
    const storage = [
      path.join(home, '.config', 'Code', 'User', 'globalStorage'),
      path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
      env.APPDATA ? path.join(env.APPDATA, 'Code', 'User', 'globalStorage') : null
    ].filter(Boolean);
    for (const dir of storage) addServers(((await readJson(path.join(dir, 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'))) || {}).mcpServers, 'cline', 'user', 'cline');
    for (const { file } of await listFiles(path.join(home, 'Documents', 'Cline', 'Rules'), '.md', 0)) addInstructions('cline', file, await readText(file));
    const rulesPath = path.join(workspace, '.clinerules');
    let info = null;
    try { info = await lstat(rulesPath); } catch {}
    if (info && info.isFile()) {
      const text = await readText(rulesPath);
      if (text) await addFile('rule', 'cline', rulesPath, path.join(workspace, '.claude', 'rules', 'clinerules.md'), '<!-- imported from .clinerules -->\n' + text.trim() + '\n', '.clinerules');
    } else if (info && info.isDirectory()) {
      for (const { file, parts } of await listFiles(rulesPath, '.md', 0)) {
        const text = await readText(file);
        if (text) await addFile('rule', 'cline', file, path.join(workspace, '.claude', 'rules', 'cline-' + slug(parts[0]) + '.md'), '<!-- imported from .clinerules/' + parts[0] + '.md -->\n' + text.trim() + '\n', parts[0]);
      }
      await addMarkdownCommands('cline', path.join(rulesPath, 'workflows'), path.join(workspace, '.oasis', 'commands'), 'project');
    }
  }
  return { root: workspace, sources, items, userMcpFile, projectMcpFile, userSkillsDir, env: { ...env, OASIS_CONFIG_DIR: configDir } };
}

export function describePlan(plan) {
  const adds = plan.items.filter((item) => item.action !== 'skip');
  const skips = plan.items.filter((item) => item.action === 'skip');
  if (!plan.items.length) return 'Nothing to import from ' + plan.sources.join(', ') + '. Looked for Codex (~/.codex), Gemini CLI (~/.gemini, .gemini/, GEMINI.md), Cursor (~/.cursor, .cursor/, .cursorrules), Claude Code memories (~/.claude/projects), Hermes (~/.hermes), OpenCode (opencode.json, .opencode/), Antigravity (~/.gemini/config, .agents/), Windsurf (~/.codeium/windsurf, .windsurf/) and Cline (.clinerules) configuration.';
  const label = { mcp: 'MCP server', instructions: 'Instructions', command: 'Command', rule: 'Rule', skill: 'Skill', memory: 'Memory', agent: 'Subagent' };
  const line = (item) => '  ' + (item.action === 'skip' ? '- ' : '+ ') + '[' + item.source + '] ' + label[item.kind] + ' ' + item.name + ((item.kind === 'mcp' || item.kind === 'memory') && item.scope ? ' (' + item.scope + ')' : '') + (item.target && item.action !== 'skip' ? ' -> ' + item.target : '') + (item.reason ? ' (skipped: ' + item.reason + ')' : '');
  return [adds.length ? 'Will import ' + adds.length + ' item' + (adds.length === 1 ? '' : 's') + ':' : 'Nothing new to import.', ...adds.map(line), ...(skips.length ? ['Skipped:', ...skips.map(line)] : [])].join('\n');
}

export async function applyImport(plan) {
  const done = [];
  const mcp = { user: null, project: null };
  // Validate every destination before the first write so one unsafe item cannot
  // leave a partially-applied import behind.
  for (const item of plan.items) {
    if (item.action === 'skip' || item.kind === 'memory') continue;
    if (item.kind === 'skill') {
      await assertSafeImportTarget({ ...plan, allowDirectoryTarget: true }, item.target);
      if (await exists(item.target)) throw new Error('Import destination already exists: ' + item.target);
      continue;
    }
    await assertSafeImportTarget(plan, importItemTarget(plan, item));
  }
  for (const item of plan.items) {
    if (item.action === 'skip') continue;
    if (item.kind === 'mcp') {
      const file = importItemTarget(plan, item);
      if (!mcp[item.scope]) mcp[item.scope] = (await readJson(file)) || {};
      mcp[item.scope].mcpServers ||= {};
      mcp[item.scope].mcpServers[item.name] = item.server;
      done.push(item);
      continue;
    }
    if (item.kind === 'memory') {
      const { saveMemory } = await import('./auto-memory.mjs');
      await saveMemory(plan.root, { scope: item.scope, name: item.name, content: item.content, category: item.category }, { env: plan.env || process.env, source: 'import:' + item.source });
      done.push(item);
      continue;
    }
    if (item.kind === 'skill') {
      await copySkillDirectory(item.from, item.target);
      done.push(item);
      continue;
    }
    await mkdir(path.dirname(item.target), { recursive: true });
    await assertSafeImportTarget(plan, item.target);
    if (item.action === 'append') {
      const before = (await readText(item.target)) || '';
      await writeImportFileAtomically(item.target, before + item.content, 0o600);
    } else {
      await writeFile(item.target, item.content, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    }
    done.push(item);
  }
  for (const [scope, data] of Object.entries(mcp)) {
    if (!data) continue;
    const file = scope === 'user' ? plan.userMcpFile : plan.projectMcpFile;
    await mkdir(path.dirname(file), { recursive: true });
    await assertSafeImportTarget(plan, file);
    await writeImportFileAtomically(file, JSON.stringify(data, null, 2) + '\n', scope === 'user' ? 0o600 : 0o644);
  }
  return done;
}

async function copySkillDirectory(from, target) {
  let total = 0;
  async function measure(dir, depth) {
    if (depth > 6) throw new Error('Skill folder is nested too deeply: ' + from);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await measure(full, depth + 1);
      else if (entry.isFile()) { total += (await lstat(full)).size; if (total > MAX_SKILL_BYTES) throw new Error('Skill folder is larger than 4 MB: ' + from); }
    }
  }
  await measure(from, 0);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(from, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, filter: async (src) => { try { const info = await lstat(src); return !info.isSymbolicLink() && !src.split(path.sep).includes('.git'); } catch { return false; } } });
}

export function parseImportArgs(args) {
  const list = Array.isArray(args) ? args : String(args || '').split(/\s+/).filter(Boolean);
  const sources = [];
  let dryRun = false;
  let yes = false;
  for (const arg of list) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (IMPORT_SOURCES.includes(arg.toLowerCase())) sources.push(arg.toLowerCase());
    else throw new Error('Unknown import option ' + arg + '. Usage: import [' + IMPORT_SOURCES.join('|') + '] [--dry-run] [--yes]');
  }
  return { sources, dryRun, yes };
}

const SOURCE_LABELS = { codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', claude: 'Claude Code', hermes: 'Hermes', opencode: 'OpenCode', antigravity: 'Antigravity', windsurf: 'Windsurf', cline: 'Cline' };

// Startup hint for people arriving from another agent: name what /import would
// bring over. Shown once for a given set of items; a new item shows it again.
export async function importStartupNotice(root, options = {}) {
  const env = options.env || process.env;
  if (env.OASIS_IMPORT_NOTICE === '0') return '';
  const plan = await planImport(root, { env, home: options.home });
  const pending = plan.items.filter((item) => item.action !== 'skip');
  if (!pending.length) return '';
  const { createHash } = await import('node:crypto');
  const signature = createHash('sha256').update(pending.map((item) => item.source + ':' + item.kind + ':' + item.name).sort().join('\n')).digest('hex').slice(0, 16);
  const statePath = options.statePath || path.join(getConfigDirectory(env), 'import-notice.json');
  const state = (await readJson(statePath)) || {};
  const seen = Array.isArray(state.seen) ? state.seen : [];
  if (seen.includes(signature)) return '';
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ seen: [...seen, signature].slice(-50) }, null, 2) + '\n');
  const sources = [...new Set(pending.map((item) => SOURCE_LABELS[item.source] || item.source))];
  const nouns = { mcp: 'MCP server', instructions: 'instructions file', command: 'command', rule: 'rule', skill: 'skill', memory: 'memory', agent: 'subagent' };
  const counts = new Map();
  for (const item of pending) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  const parts = [...counts].map(([kind, n]) => n + ' ' + (nouns[kind] || kind) + (n === 1 ? '' : (kind === 'memory' ? '' : 's')));
  return 'Found your setup from ' + sources.join(', ') + ' (' + parts.join(', ') + '). Type /import to bring it over; nothing changes until you confirm.';
}
