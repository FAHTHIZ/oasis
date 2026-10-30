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
import { mkdir, readFile, readdir, writeFile, lstat, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

export const IMPORT_SOURCES = ['codex', 'gemini', 'cursor'];
const MAX_FILE = 256 * 1024;

// ---- minimal TOML (tables, dotted keys, strings, arrays, inline tables, numbers, booleans) ----
export function parseToml(text) {
  const root = {};
  let current = root;
  let i = 0;
  const src = String(text).replace(/\r\n/g, '\n');
  const ws = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; };
  const wsnl = () => { for (;;) { ws(); if (src[i] === '\n') { i++; continue; } if (src[i] === '#') { while (i < src.length && src[i] !== '\n') i++; continue; } break; } };
  const key = () => {
    ws();
    if (src[i] === '"' || src[i] === "'") return string();
    const start = i;
    while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) i++;
    if (start === i) throw new Error('TOML: expected a key at offset ' + i);
    return src.slice(start, i);
  };
  const dotted = () => { const parts = [key()]; ws(); while (src[i] === '.') { i++; parts.push(key()); ws(); } return parts; };
  const string = () => {
    const quote = src[i];
    if (src.startsWith(quote.repeat(3), i)) {
      i += 3;
      if (src[i] === '\n') i++;
      const end = src.indexOf(quote.repeat(3), i);
      if (end < 0) throw new Error('TOML: unterminated multi-line string');
      let raw = src.slice(i, end);
      i = end + 3;
      while (src[i] === quote) { raw += quote; i++; }
      return quote === '"' ? unescape(raw.replace(/\\\n\s*/g, '')) : raw;
    }
    i++;
    let out = '';
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\n') throw new Error('TOML: newline in string');
      if (quote === '"' && src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; continue; }
      out += src[i++];
    }
    if (i >= src.length) throw new Error('TOML: unterminated string at offset ' + i);
    i++;
    return quote === '"' ? unescape(out) : out;
  };
  const unescape = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (m, c) => {
    if (c[0] === 'u' || c[0] === 'U') return String.fromCodePoint(parseInt(c.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[c] ?? c;
  });
  const value = () => {
    ws();
    const ch = src[i];
    if (ch === '"' || ch === "'") return string();
    if (ch === '[') {
      i++;
      const arr = [];
      for (;;) {
        wsnl();
        if (i >= src.length) throw new Error('TOML: unterminated array at offset ' + i);
        if (src[i] === ']') { i++; return arr; }
        const before = i;
        arr.push(value());
        if (i <= before) throw new Error('TOML: expected an array value at offset ' + i);
        wsnl();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        throw new Error('TOML: expected , or ] at offset ' + i);
      }
    }
    if (ch === '{') {
      i++;
      const obj = {};
      for (;;) { ws(); if (src[i] === '}') { i++; return obj; } const parts = dotted(); ws(); if (src[i] !== '=') throw new Error('TOML: expected ='); i++; assign(obj, parts, value()); ws(); if (src[i] === ',') i++; }
    }
    const start = i;
    while (i < src.length && !/[,\]}\n#]/.test(src[i])) i++;
    const raw = src.slice(start, i).trim();
    if (!raw) throw new Error('TOML: expected a value at offset ' + start);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const num = Number(raw.replace(/_/g, ''));
    return Number.isFinite(num) ? num : raw;
  };
  const assign = (obj, parts, v) => {
    let target = obj;
    for (const part of parts.slice(0, -1)) target = (target[part] && typeof target[part] === 'object') ? target[part] : (target[part] = {});
    target[parts[parts.length - 1]] = v;
  };
  while (i < src.length) {
    wsnl();
    if (i >= src.length) break;
    if (src[i] === '[') {
      const array = src[i + 1] === '[';
      i += array ? 2 : 1;
      const parts = dotted();
      i += array ? 2 : 1;
      let target = root;
      for (const part of parts.slice(0, -1)) target = (target[part] && typeof target[part] === 'object') ? (Array.isArray(target[part]) ? target[part][target[part].length - 1] : target[part]) : (target[part] = {});
      const last = parts[parts.length - 1];
      if (array) { (target[last] ||= []).push({}); current = target[last][target[last].length - 1]; }
      else current = (target[last] && typeof target[last] === 'object') ? target[last] : (target[last] = {});
      continue;
    }
    const parts = dotted();
    ws();
    if (src[i] !== '=') throw new Error('TOML: expected = after ' + parts.join('.'));
    i++;
    assign(current, parts, value());
  }
  return root;
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
  const url = flavor === 'gemini' ? (raw.httpUrl || raw.url) : raw.url;
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

function geminiCommandToMarkdown(toml) {
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
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n/g, '\n'));
  const body = (match ? text.replace(/\r\n/g, '\n').slice(match[0].length) : text).trim();
  const meta = {};
  if (match) for (const line of match[1].split('\n')) { const m = /^(\w+):\s*(.*)$/.exec(line); if (m) meta[m[1]] = m[2].trim(); }
  const lines = ['---'];
  if (meta.description) lines.push('description: ' + JSON.stringify(meta.description.replace(/^["']|["']$/g, '')));
  let globs = meta.globs ? meta.globs.replace(/^\[|\]$/g, '').split(',').map((g) => g.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
  if (meta.alwaysApply === 'true') globs = [];
  if (globs.length) { lines.push('paths:'); for (const g of globs) lines.push('  - ' + JSON.stringify(g)); }
  lines.push('---', '', '<!-- imported from Cursor rule ' + name + ' -->', body, '');
  return (lines.length > 3 ? lines.join('\n') : lines.slice(2).join('\n'));
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
  const base = isWithinPath(workspace, target) ? workspace :
    (isWithinPath(userConfig, target) ? userConfig : null);
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
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Refusing to import to a non-regular or symbolic-link destination: ' + target);
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
  }export async function applyImport(plan) {
  const done = [];
  const mcp = { user: null, project: null };
  // Validate every destination before the first write so one unsafe item cannot
  // leave a partially-applied import behind.
  for (const item of plan.items) {
    if (item.action !== 'skip') await assertSafeImportTarget(plan, importItemTarget(plan, item));
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

 root: workspace, sources, items, userMcpFile, projectMcpFile };
}

export function describePlan(plan) {
  const adds = plan.items.filter((item) => item.action !== 'skip');
  const skips = plan.items.filter((item) => item.action === 'skip');
  if (!plan.items.length) return 'Nothing to import from ' + plan.sources.join(', ') + '. Looked for Codex (~/.codex), Gemini CLI (~/.gemini, .gemini/, GEMINI.md) and Cursor (~/.cursor, .cursor/, .cursorrules) configuration.';
  const label = { mcp: 'MCP server', instructions: 'Instructions', command: 'Command', rule: 'Rule' };
  const line = (item) => '  ' + (item.action === 'skip' ? '- ' : '+ ') + '[' + item.source + '] ' + label[item.kind] + ' ' + item.name + (item.kind === 'mcp' && item.scope ? ' (' + item.scope + ')' : '') + (item.target && item.action !== 'skip' ? ' -> ' + item.target : '') + (item.reason ? ' (skipped: ' + item.reason + ')' : '');
  return [adds.length ? 'Will import ' + adds.length + ' item' + (adds.length === 1 ? '' : 's') + ':' : 'Nothing new to import.', ...adds.map(line), ...(skips.length ? ['Skipped:', ...skips.map(line)] : [])].join('\n');
}

export async function applyImport(plan) {
  const done = [];
  const mcp = { user: null, project: null };
  for (const item of plan.items) {
    if (item.action === 'skip') continue;
    if (item.kind === 'mcp') {
      const file = item.scope === 'user' ? plan.userMcpFile : plan.projectMcpFile;
      if (!mcp[item.scope]) mcp[item.scope] = (await readJson(file)) || {};
      mcp[item.scope].mcpServers ||= {};
      mcp[item.scope].mcpServers[item.name] = item.server;
      done.push(item);
      continue;
    }
    await mkdir(path.dirname(item.target), { recursive: true });
    if (item.action === 'append') {
      const before = (await readText(item.target)) || '';
      await writeFile(item.target, before + item.content, { mode: 0o600 });
    } else {
      await writeFile(item.target, item.content, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    }
    done.push(item);
  }
  for (const [scope, data] of Object.entries(mcp)) {
    if (!data) continue;
    const file = scope === 'user' ? plan.userMcpFile : plan.projectMcpFile;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2) + '\n', scope === 'user' ? { mode: 0o600 } : {});
  }
  return done;
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
    else throw new Error('Unknown import option ' + arg + '. Usage: import [codex|gemini|cursor] [--dry-run] [--yes]');
  }
  return { sources, dryRun, yes };
}
