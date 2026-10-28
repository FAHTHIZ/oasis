// Native Claude Code plugin and marketplace support.
//
// OASIS installs and runs plugins written for Claude Code without conversion:
//   oasis plugin marketplace add anthropics/claude-code      (GitHub owner/repo, git URL, or local path)
//   oasis plugin install code-review@claude-code-plugins
//   oasis plugin list | enable | disable | uninstall | update | validate
//
// A plugin is a directory with an optional .claude-plugin/plugin.json manifest and any of
// commands/, agents/, skills/, hooks/hooks.json, and .mcp.json. Enabled plugins contribute:
//   - slash commands named /plugin-name:command
//   - subagents named plugin-name:agent
//   - Agent Skills (SKILL.md)
//   - hooks (run with CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA in their environment)
//   - MCP servers (with ${CLAUDE_PLUGIN_ROOT} expanded)
//
// Enablement uses Claude Code's settings format: "enabledPlugins": { "name@marketplace": true }
// in user settings, or project .claude/settings.json once the workspace is trusted. Plugins
// already installed by Claude Code (~/.claude/plugins/installed_plugins.json) and enabled in
// ~/.claude/settings.json are picked up automatically. Plugins run code (hooks, MCP servers)
// with your permissions, exactly as in Claude Code: install only plugins you trust.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_JSON = 1024 * 1024;
const MAX_MD = 256 * 1024;

export function pluginHome(env = process.env) {
  return path.join(getConfigDirectory(env), 'plugins');
}

function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(env.HOME || os.homedir(), '.claude');
}

async function readJson(file, fallback = null) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_JSON) return fallback;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

async function exists(file) { try { await stat(file); return true; } catch { return false; } }

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: options.timeout || 180000, cwd: options.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.error) throw new Error('git is required for plugin marketplaces: ' + result.error.message);
  if (result.status !== 0) throw new Error('git ' + args[0] + ' failed: ' + String(result.stderr || result.stdout).trim().slice(0, 500));
  return String(result.stdout || '').trim();
}

// ---------- registries ----------

const marketplacesFile = (env) => path.join(pluginHome(env), 'known_marketplaces.json');
const installedFile = (env) => path.join(pluginHome(env), 'installed_plugins.json');

export async function readMarketplaces(env = process.env) {
  const data = await readJson(marketplacesFile(env), {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export async function readInstalledPlugins(env = process.env) {
  const data = await readJson(installedFile(env), {});
  const plugins = data && data.plugins && typeof data.plugins === 'object' ? data.plugins : {};
  return plugins;
}

async function writeInstalledPlugins(plugins, env) {
  await writeJson(installedFile(env), { version: 1, plugins });
}

// Claude Code's own registry (v1: { plugins: { id: { installPath } } }, v2: { plugins: { id: [ { installPath, scope } ] } }).
async function readClaudeCodeInstalled(env) {
  const data = await readJson(path.join(claudeHome(env), 'plugins', 'installed_plugins.json'), null);
  const out = {};
  if (!data || !data.plugins || typeof data.plugins !== 'object') return out;
  for (const [id, value] of Object.entries(data.plugins)) {
    const entry = Array.isArray(value) ? value.find((item) => item && item.installPath) : value;
    if (entry && typeof entry.installPath === 'string') out[id] = { installPath: entry.installPath, version: entry.version || null, source: 'claude-code' };
  }
  return out;
}

// ---------- settings: enabledPlugins ----------

async function settingsFiles(root, env, trusted) {
  const { userSettingsPath } = await import('./settings.mjs');
  const files = [
    { scope: 'claude-user', file: path.join(claudeHome(env), 'settings.json'), applies: true },
    { scope: 'user', file: userSettingsPath(env), applies: true }
  ];
  if (root) {
    for (const [scope, rel] of [['project', '.claude/settings.json'], ['project', '.oasis/settings.json'], ['local', '.claude/settings.local.json'], ['local', '.oasis/settings.local.json']]) {
      files.push({ scope, file: path.join(root, rel), applies: trusted });
    }
  }
  return files;
}

/** Merged enabledPlugins map (later scopes win) plus project declarations needing trust. */
export async function resolveEnabledPlugins(root, env = process.env) {
  const { isWorkspaceTrusted } = await import('./settings.mjs');
  const trusted = root ? await isWorkspaceTrusted(root, env).catch(() => false) : false;
  const enabled = {};
  const declaredUntrusted = [];
  const extraMarketplaces = {};
  for (const item of await settingsFiles(root, env, trusted)) {
    const settings = await readJson(item.file, null);
    if (!settings || typeof settings !== 'object') continue;
    const map = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' && !Array.isArray(settings.enabledPlugins) ? settings.enabledPlugins : {};
    if (!item.applies) { for (const [id, on] of Object.entries(map)) if (on === true) declaredUntrusted.push(id); continue; }
    for (const [id, on] of Object.entries(map)) if (typeof on === 'boolean') enabled[id] = on;
    if (settings.extraKnownMarketplaces && typeof settings.extraKnownMarketplaces === 'object') Object.assign(extraMarketplaces, settings.extraKnownMarketplaces);
  }
  return { enabled, declaredUntrusted, extraMarketplaces, trusted };
}

async function setEnabled(id, value, { env = process.env, root = null, scope = 'user' } = {}) {
  const { userSettingsPath } = await import('./settings.mjs');
  const file = scope === 'project' ? path.join(root, '.claude', 'settings.json')
    : scope === 'local' ? path.join(root, '.claude', 'settings.local.json')
      : userSettingsPath(env);
  const settings = (await readJson(file, {})) || {};
  settings.enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  if (value === null) delete settings.enabledPlugins[id]; else settings.enabledPlugins[id] = value;
  await writeJson(file, settings);
  return file;
}

// ---------- discovery of active plugins ----------

/**
 * All enabled, installed plugins for this workspace, plus any --plugin-dir directories
 * (OASIS_PLUGIN_DIRS, path-delimited). Each entry: { id, name, root, manifest, origin }.
 */
export async function loadEnabledPlugins(root, options = {}) {
  const env = options.env || process.env;
  if (/^(0|off|false)$/i.test(String(env.OASIS_PLUGINS || ''))) return [];
  const { enabled } = await resolveEnabledPlugins(root, env);
  const registries = { ...(await readClaudeCodeInstalled(env)), ...(await readInstalledPlugins(env)) };
  const out = [];
  const seen = new Set();
  const add = async (id, pluginRoot, origin) => {
    try {
      const real = await realpath(pluginRoot);
      if (seen.has(real)) return;
      const manifest = await readManifest(real);
      const name = String(manifest.name || id.split('@')[0] || path.basename(real)).toLowerCase();
      if (!NAME.test(name)) return;
      seen.add(real);
      out.push({ id: id || name, name, root: real, manifest, origin });
    } catch { /* missing plugin directories are reported by `oasis plugin list` */ }
  };
  for (const dir of String(env.OASIS_PLUGIN_DIRS || '').split(path.delimiter).filter(Boolean)) await add('', path.resolve(dir), 'plugin-dir');
  for (const [id, record] of Object.entries(registries)) {
    if (enabled[id] !== true) continue;
    await add(id, record.installPath, record.source === 'claude-code' ? 'claude-code' : 'oasis');
  }
  return out;
}

export async function readManifest(pluginRoot) {
  const manifest = await readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), null);
  return manifest && typeof manifest === 'object' ? manifest : {};
}

export function pluginVariables(plugin, env = process.env, root = '') {
  const data = path.join(pluginHome(env), 'data', plugin.id.replace(/[^a-zA-Z0-9._-]/g, '-') || plugin.name);
  return { CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PLUGIN_DATA: data, ...(root ? { CLAUDE_PROJECT_DIR: root } : {}) };
}

export function expandPluginVariables(text, vars) {
  return String(text).replace(/\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR)\}/g, (match, name) => vars[name] ?? match);
}

function asList(value) {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function resolveInPlugin(plugin, rel) {
  const target = path.resolve(plugin.root, rel);
  return inside(plugin.root, target) ? target : null;
}

async function markdownFiles(dir, depth = 0) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3 && !entry.name.startsWith('.')) out.push(...(await markdownFiles(full, depth + 1)).map((item) => ({ ...item, parts: [entry.name, ...item.parts] })));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push({ file: full, parts: [entry.name.replace(/\.md$/i, '')] });
  }
  return out;
}

async function componentFiles(plugin, key, defaultDir) {
  const declared = asList(plugin.manifest[key]);
  const roots = declared.length ? declared.map((rel) => resolveInPlugin(plugin, rel)).filter(Boolean) : [];
  const defaultPath = path.join(plugin.root, defaultDir);
  if (!roots.includes(defaultPath)) roots.unshift(defaultPath);
  const files = [];
  for (const target of roots) {
    let info;
    try { info = await stat(target); } catch { continue; }
    if (info.isFile() && target.endsWith('.md')) files.push({ file: target, parts: [path.basename(target, '.md')] });
    else if (info.isDirectory()) files.push(...await markdownFiles(target));
  }
  return files;
}

async function readText(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_MD) throw new Error('too large');
  return readFile(file, 'utf8');
}

/** Slash commands: [{ name: 'plugin:cmd', file, body, plugin }] with variables expanded. */
export async function pluginCommands(plugins, options = {}) {
  const out = [];
  for (const plugin of plugins) {
    const vars = pluginVariables(plugin, options.env, options.root);
    const inline = plugin.manifest.commands && typeof plugin.manifest.commands === 'object' && !Array.isArray(plugin.manifest.commands) ? plugin.manifest.commands : null;
    if (inline) {
      for (const [key, spec] of Object.entries(inline)) {
        if (!spec || typeof spec !== 'object') continue;
        let body = typeof spec.content === 'string' ? spec.content : '';
        const source = typeof spec.source === 'string' ? resolveInPlugin(plugin, spec.source) : null;
        if (!body && source) body = await readText(source).catch(() => '');
        if (!body) continue;
        const front = ['---', spec.description ? 'description: ' + String(spec.description).replace(/\n/g, ' ') : '', spec.argumentHint ? 'argument-hint: ' + spec.argumentHint : '', spec.model ? 'model: ' + spec.model : '', '---', ''].filter((line, i) => line || i === 5).join('\n');
        out.push({ name: plugin.name + ':' + key.toLowerCase(), file: source || path.join(plugin.root, '.claude-plugin', 'plugin.json'), body: expandPluginVariables(body.startsWith('---') ? body : front + body, vars), plugin: plugin.id });
      }
      continue;
    }
    for (const item of await componentFiles(plugin, 'commands', 'commands')) {
      const body = await readText(item.file).catch(() => null);
      if (body === null) continue;
      out.push({ name: plugin.name + ':' + item.parts.join(':').toLowerCase(), file: item.file, body: expandPluginVariables(body, vars), plugin: plugin.id });
    }
  }
  return out;
}

/** Subagent definitions: [{ name: 'plugin:agent', file, body, plugin }]. */
export async function pluginAgents(plugins, options = {}) {
  const out = [];
  for (const plugin of plugins) {
    const vars = pluginVariables(plugin, options.env, options.root);
    for (const item of await componentFiles(plugin, 'agents', 'agents')) {
      const body = await readText(item.file).catch(() => null);
      if (body === null) continue;
      out.push({ name: plugin.name + ':' + item.parts[item.parts.length - 1].toLowerCase(), file: item.file, body: expandPluginVariables(body, vars), plugin: plugin.id });
    }
  }
  return out;
}

/** Skill directories: [{ name, file (SKILL.md), dir, plugin }]. */
export async function pluginSkills(plugins) {
  const out = [];
  for (const plugin of plugins) {
    const roots = [path.join(plugin.root, 'skills'), ...asList(plugin.manifest.skills).map((rel) => resolveInPlugin(plugin, rel)).filter(Boolean)];
    if (await exists(path.join(plugin.root, 'SKILL.md'))) out.push({ name: plugin.name, file: path.join(plugin.root, 'SKILL.md'), dir: plugin.root, plugin: plugin.id });
    for (const dir of [...new Set(roots)]) {
      if (await exists(path.join(dir, 'SKILL.md'))) { out.push({ name: path.basename(dir), file: path.join(dir, 'SKILL.md'), dir, plugin: plugin.id }); continue; }
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, 'SKILL.md');
        if (await exists(file)) out.push({ name: entry.name, file, dir: path.join(dir, entry.name), plugin: plugin.id });
      }
    }
  }
  return out;
}

async function jsonComponent(plugin, value, defaultFile, key) {
  const results = [];
  const fromFile = async (file) => {
    const data = await readJson(file, null);
    if (data && typeof data === 'object') results.push(data[key] && typeof data[key] === 'object' ? data[key] : data);
  };
  if (await exists(path.join(plugin.root, defaultFile))) await fromFile(path.join(plugin.root, defaultFile));
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const item of items) {
    if (typeof item === 'string') { const file = resolveInPlugin(plugin, item); if (file && file !== path.join(plugin.root, defaultFile)) await fromFile(file); }
    else if (item && typeof item === 'object') results.push(item[key] && typeof item[key] === 'object' ? item[key] : item);
  }
  return results;
}

/** Hooks grouped by event, Claude Code format, tagged with the plugin's environment. */
export async function pluginHooks(plugins, options = {}) {
  const out = [];
  for (const plugin of plugins) {
    const vars = pluginVariables(plugin, options.env, options.root);
    for (const hooks of await jsonComponent(plugin, plugin.manifest.hooks, path.join('hooks', 'hooks.json'), 'hooks')) {
      out.push({ plugin: plugin.id, hooks, env: vars });
    }
  }
  return out;
}

/** MCP server specs ({ name: spec }) with plugin variables expanded. */
export async function pluginMcpServers(plugins, options = {}) {
  const out = [];
  for (const plugin of plugins) {
    const vars = pluginVariables(plugin, options.env, options.root);
    for (const map of await jsonComponent(plugin, plugin.manifest.mcpServers, '.mcp.json', 'mcpServers')) {
      const expanded = JSON.parse(JSON.stringify(map), (key, value) => typeof value === 'string' ? expandPluginVariables(value, vars) : value);
      out.push({ plugin: plugin.id, mcpServers: expanded, env: vars });
    }
  }
  return out;
}

// ---------- marketplaces ----------

function parseSource(input, cwd) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Usage: oasis plugin marketplace add OWNER/REPO | GIT-URL | PATH');
  const [base, ref] = text.split('#');
  const local = path.resolve(cwd, base);
  if (/^(\.|\/|~|[A-Za-z]:\\)/.test(base)) return { type: 'directory', path: local.replace(/^~/, os.homedir()) };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(base)) return { type: 'github', repo: base, url: 'https://github.com/' + base + '.git', ...(ref ? { ref } : {}) };
  if (/^(https:\/\/|git@|ssh:\/\/|file:\/\/)/.test(base)) return { type: 'git', url: base, ...(ref ? { ref } : {}) };
  return { type: 'directory', path: local };
}

async function readMarketplaceManifest(dir) {
  const manifest = await readJson(path.join(dir, '.claude-plugin', 'marketplace.json'), null);
  if (!manifest || typeof manifest !== 'object') throw new Error('No .claude-plugin/marketplace.json found in ' + dir);
  if (!manifest.name || !NAME.test(String(manifest.name))) throw new Error('marketplace.json needs a kebab-case "name".');
  if (!Array.isArray(manifest.plugins)) throw new Error('marketplace.json needs a "plugins" array.');
  return manifest;
}

function clone(url, dest, ref) {
  git(['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, dest]);
}

export async function addMarketplace(input, options = {}) {
  const env = options.env || process.env;
  const source = parseSource(input, options.cwd || process.cwd());
  const home = pluginHome(env);
  let location;
  if (source.type === 'directory') {
    location = await realpath(source.path);
  } else {
    const staging = path.join(home, 'marketplaces', '.staging-' + process.pid + '-' + Date.now());
    await mkdir(path.dirname(staging), { recursive: true });
    clone(source.url, staging, source.ref);
    location = staging;
  }
  const manifest = await readMarketplaceManifest(location).catch(async (error) => {
    if (source.type !== 'directory') await rm(location, { recursive: true, force: true });
    throw error;
  });
  const name = String(manifest.name).toLowerCase();
  if (source.type !== 'directory') {
    const final = path.join(home, 'marketplaces', name);
    await rm(final, { recursive: true, force: true });
    await cp(location, final, { recursive: true });
    await rm(location, { recursive: true, force: true });
    location = final;
  }
  const known = await readMarketplaces(env);
  known[name] = { source, installLocation: location, lastUpdated: new Date().toISOString() };
  await writeJson(marketplacesFile(env), known);
  return { name, location, plugins: manifest.plugins.map((p) => p && p.name).filter(Boolean) };
}

export async function updateMarketplace(name, options = {}) {
  const env = options.env || process.env;
  const known = await readMarketplaces(env);
  const names = name ? [name] : Object.keys(known);
  const updated = [];
  for (const item of names) {
    const record = known[item];
    if (!record) throw new Error('Unknown marketplace "' + item + '". Run oasis plugin marketplace list.');
    if (record.source.type !== 'directory') {
      git(['fetch', '--depth', '1', 'origin', ...(record.source.ref ? [record.source.ref] : [])], { cwd: record.installLocation });
      git(['reset', '--hard', 'FETCH_HEAD'], { cwd: record.installLocation });
    }
    await readMarketplaceManifest(record.installLocation);
    record.lastUpdated = new Date().toISOString();
    updated.push(item);
  }
  await writeJson(marketplacesFile(env), known);
  return updated;
}

export async function removeMarketplace(name, options = {}) {
  const env = options.env || process.env;
  const known = await readMarketplaces(env);
  const record = known[name];
  if (!record) throw new Error('Unknown marketplace "' + name + '".');
  delete known[name];
  await writeJson(marketplacesFile(env), known);
  if (record.source.type !== 'directory' && inside(path.join(pluginHome(env), 'marketplaces'), record.installLocation)) await rm(record.installLocation, { recursive: true, force: true });
}

async function findPlugin(spec, env) {
  const [pluginName, marketName] = String(spec || '').toLowerCase().split('@');
  if (!pluginName) throw new Error('Usage: oasis plugin install NAME@MARKETPLACE');
  const known = await readMarketplaces(env);
  const candidates = [];
  for (const [market, record] of Object.entries(known)) {
    if (marketName && market !== marketName) continue;
    const manifest = await readMarketplaceManifest(record.installLocation).catch(() => null);
    const entry = manifest && manifest.plugins.find((item) => item && String(item.name).toLowerCase() === pluginName);
    if (entry) candidates.push({ market, record, manifest, entry });
  }
  if (!candidates.length) throw new Error('Plugin "' + spec + '" was not found' + (marketName ? ' in marketplace ' + marketName : ' in any added marketplace') + '. Add one with oasis plugin marketplace add OWNER/REPO.');
  if (candidates.length > 1) throw new Error('"' + pluginName + '" exists in several marketplaces (' + candidates.map((c) => c.market).join(', ') + '). Use NAME@MARKETPLACE.');
  return candidates[0];
}

export async function installPlugin(spec, options = {}) {
  const env = options.env || process.env;
  const { market, record, manifest, entry } = await findPlugin(spec, env);
  const name = String(entry.name).toLowerCase();
  if (!NAME.test(name)) throw new Error('Invalid plugin name in marketplace: ' + entry.name);
  const id = name + '@' + market;
  const source = entry.source;
  const cacheDir = path.join(pluginHome(env), 'cache', market, name);
  let installPath;
  await rm(cacheDir, { recursive: true, force: true });
  if (typeof source === 'string') {
    const base = manifest.metadata && typeof manifest.metadata.pluginRoot === 'string' ? path.resolve(record.installLocation, manifest.metadata.pluginRoot) : record.installLocation;
    const from = path.resolve(base, source);
    if (!inside(record.installLocation, from)) throw new Error('Plugin source escapes its marketplace: ' + source);
    if (!(await exists(from))) throw new Error('Plugin source directory is missing: ' + from);
    installPath = cacheDir;
    await cp(from, installPath, { recursive: true, filter: (file) => !file.split(path.sep).includes('.git') });
  } else if (source && typeof source === 'object') {
    const kind = source.source;
    const url = kind === 'github' ? 'https://github.com/' + source.repo + '.git' : source.url;
    if (!['github', 'url', 'git-subdir'].includes(kind) || typeof url !== 'string') throw new Error('Plugin source type "' + kind + '" is not supported yet (use relative, github, url, or git-subdir).');
    const staging = cacheDir + '.staging';
    await rm(staging, { recursive: true, force: true });
    await mkdir(path.dirname(staging), { recursive: true });
    clone(url, staging, source.ref);
    if (source.sha) { git(['fetch', '--depth', '1', 'origin', source.sha], { cwd: staging }); git(['checkout', '--quiet', source.sha], { cwd: staging }); }
    const from = kind === 'git-subdir' ? path.resolve(staging, String(source.path || '')) : staging;
    if (!inside(staging, from)) throw new Error('git-subdir path escapes the repository.');
    installPath = cacheDir;
    await cp(from, installPath, { recursive: true, filter: (file) => !path.relative(from, file).split(path.sep).includes('.git') });
    await rm(staging, { recursive: true, force: true });
  } else {
    throw new Error('Plugin entry "' + name + '" has no source.');
  }
  // strict: false marketplace entries may define components that the plugin has no manifest for.
  if (entry.strict === false && !(await exists(path.join(installPath, '.claude-plugin', 'plugin.json')))) {
    const { source: _source, strict: _strict, ...fields } = entry;
    await writeJson(path.join(installPath, '.claude-plugin', 'plugin.json'), fields);
  }
  const installed = await readInstalledPlugins(env);
  const pluginManifest = await readManifest(installPath);
  installed[id] = { installPath, version: pluginManifest.version || entry.version || null, marketplace: market, installedAt: new Date().toISOString() };
  await writeInstalledPlugins(installed, env);
  await setEnabled(id, true, { env, root: options.root, scope: options.scope || 'user' });
  const plugin = { id, name, root: installPath, manifest: pluginManifest };
  return { id, installPath, summary: await summarizePlugin(plugin, { env }) };
}

export async function uninstallPlugin(spec, options = {}) {
  const env = options.env || process.env;
  const installed = await readInstalledPlugins(env);
  const id = resolveInstalledId(spec, installed);
  const record = installed[id];
  delete installed[id];
  await writeInstalledPlugins(installed, env);
  await setEnabled(id, null, { env });
  if (inside(path.join(pluginHome(env), 'cache'), record.installPath)) await rm(record.installPath, { recursive: true, force: true });
  return id;
}

function resolveInstalledId(spec, installed) {
  const text = String(spec || '').toLowerCase();
  if (installed[text]) return text;
  const matches = Object.keys(installed).filter((id) => id.split('@')[0] === text);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('Several installed plugins are named "' + text + '": ' + matches.join(', '));
  throw new Error('Plugin "' + spec + '" is not installed. Run oasis plugin list.');
}

export async function setPluginEnabled(spec, value, options = {}) {
  const env = options.env || process.env;
  const installed = { ...(await readClaudeCodeInstalled(env)), ...(await readInstalledPlugins(env)) };
  const id = resolveInstalledId(spec, installed);
  const file = await setEnabled(id, value, { env, root: options.root, scope: options.scope || 'user' });
  return { id, file };
}

export async function summarizePlugin(plugin, options = {}) {
  const [commands, agents, skills, hooks, mcp] = await Promise.all([
    pluginCommands([plugin], options), pluginAgents([plugin], options), pluginSkills([plugin]), pluginHooks([plugin], options), pluginMcpServers([plugin], options)
  ]);
  const hookCount = hooks.reduce((sum, item) => sum + Object.values(item.hooks || {}).reduce((n, groups) => n + (Array.isArray(groups) ? groups.length : 0), 0), 0);
  return {
    commands: commands.map((c) => '/' + c.name),
    agents: agents.map((a) => a.name),
    skills: skills.map((s) => s.name),
    hooks: hookCount,
    mcpServers: mcp.flatMap((item) => Object.keys(item.mcpServers || {}))
  };
}

/** Validate a plugin or marketplace directory the way `claude plugin validate` does. */
export async function validatePath(target) {
  const dir = path.resolve(target || '.');
  const problems = [];
  const report = [];
  if (await exists(path.join(dir, '.claude-plugin', 'marketplace.json'))) {
    try {
      const manifest = await readMarketplaceManifest(dir);
      report.push('Marketplace "' + manifest.name + '" with ' + manifest.plugins.length + ' plugin(s).');
      for (const entry of manifest.plugins) {
        if (!entry || !entry.name || !NAME.test(String(entry.name))) problems.push('Plugin entry with invalid or missing name: ' + JSON.stringify(entry && entry.name));
        if (!entry || !entry.source) problems.push('Plugin "' + (entry && entry.name) + '" has no source.');
        else if (typeof entry.source === 'string' && !(await exists(path.resolve(dir, manifest.metadata && manifest.metadata.pluginRoot || '.', entry.source)))) problems.push('Plugin "' + entry.name + '" source not found: ' + entry.source);
      }
    } catch (error) { problems.push(error.message); }
  }
  const manifestFile = path.join(dir, '.claude-plugin', 'plugin.json');
  if (await exists(manifestFile)) {
    const manifest = await readJson(manifestFile, null);
    if (!manifest) problems.push('.claude-plugin/plugin.json is not valid JSON.');
    else {
      if (manifest.name && !NAME.test(String(manifest.name))) problems.push('plugin.json "name" must be kebab-case.');
      const plugin = { id: String(manifest.name || path.basename(dir)), name: String(manifest.name || path.basename(dir)).toLowerCase(), root: dir, manifest };
      const summary = await summarizePlugin(plugin);
      report.push('Plugin "' + plugin.name + '"' + (manifest.version ? ' v' + manifest.version : '') + ': ' + summary.commands.length + ' command(s), ' + summary.agents.length + ' agent(s), ' + summary.skills.length + ' skill(s), ' + summary.hooks + ' hook group(s), ' + summary.mcpServers.length + ' MCP server(s).');
      const hooksFile = path.join(dir, 'hooks', 'hooks.json');
      if (await exists(hooksFile)) {
        const hooks = await readJson(hooksFile, null);
        if (!hooks) problems.push('hooks/hooks.json is not valid JSON.');
        else if (!hooks.hooks) problems.push('hooks/hooks.json should wrap events in a top-level "hooks" object.');
      }
    }
  } else if (!report.length) {
    problems.push('No .claude-plugin/plugin.json or .claude-plugin/marketplace.json found in ' + dir);
  }
  return { ok: problems.length === 0, report, problems };
}

// ---------- CLI ----------

export async function pluginCli(root, args = [], options = {}) {
  const env = options.env || process.env;
  const out = options.write || ((text) => process.stdout.write(text));
  const scopeIndex = args.indexOf('--scope');
  const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : 'user';
  const rest = scopeIndex >= 0 ? args.filter((_, i) => i !== scopeIndex && i !== scopeIndex + 1) : args;
  const [action = 'list', ...params] = rest;
  if (action === 'marketplace' || action === 'marketplaces') {
    const [sub = 'list', arg] = params;
    if (sub === 'add') {
      const added = await addMarketplace(arg, { env, cwd: root });
      out('Added marketplace "' + added.name + '" (' + added.plugins.length + ' plugin(s)): ' + added.plugins.join(', ') + '\nInstall one with: oasis plugin install NAME@' + added.name + '\n');
    } else if (sub === 'update') {
      out('Updated: ' + (await updateMarketplace(arg, { env })).join(', ') + '\n');
    } else if (sub === 'remove' || sub === 'rm') {
      await removeMarketplace(arg, { env }); out('Removed marketplace "' + arg + '". Installed plugins stay until you uninstall them.\n');
    } else {
      const known = await readMarketplaces(env);
      if (!Object.keys(known).length) out('No marketplaces. Add one with: oasis plugin marketplace add OWNER/REPO\n');
      for (const [name, record] of Object.entries(known)) {
        const manifest = await readMarketplaceManifest(record.installLocation).catch(() => null);
        out(name + ' — ' + (record.source.repo || record.source.url || record.source.path) + (manifest ? ' (' + manifest.plugins.length + ' plugins)' : ' (unreadable)') + '\n');
        for (const entry of manifest ? manifest.plugins : []) out('    ' + entry.name + (entry.description ? ' — ' + String(entry.description).slice(0, 100) : '') + '\n');
      }
    }
    return;
  }
  if (action === 'install' || action === 'i') {
    const result = await installPlugin(params[0], { env, root, scope });
    const s = result.summary;
    out('Installed and enabled ' + result.id + '\n  commands: ' + (s.commands.join(', ') || 'none') + '\n  agents: ' + (s.agents.join(', ') || 'none') + '\n  skills: ' + (s.skills.join(', ') || 'none') + '\n  hook groups: ' + s.hooks + '\n  MCP servers: ' + (s.mcpServers.join(', ') || 'none') + '\nStart a new session to load it. Plugins run hooks and MCP servers with your permissions.\n');
    return;
  }
  if (action === 'uninstall' || action === 'remove') { out('Uninstalled ' + (await uninstallPlugin(params[0], { env })) + '\n'); return; }
  if (action === 'enable' || action === 'disable') {
    const result = await setPluginEnabled(params[0], action === 'enable', { env, root, scope });
    out((action === 'enable' ? 'Enabled ' : 'Disabled ') + result.id + ' in ' + result.file + '\n'); return;
  }
  if (action === 'update') {
    const installed = await readInstalledPlugins(env);
    const ids = params[0] ? [resolveInstalledId(params[0], installed)] : Object.keys(installed);
    await updateMarketplace(null, { env }).catch(() => {});
    for (const id of ids) { await installPlugin(id, { env, root, scope }); out('Updated ' + id + '\n'); }
    return;
  }
  if (action === 'validate') {
    const result = await validatePath(params[0] || root);
    out(result.report.join('\n') + (result.report.length ? '\n' : '') + (result.ok ? 'Valid.\n' : 'Problems:\n' + result.problems.map((p) => '  - ' + p).join('\n') + '\n'));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'list' || action === 'ls') {
    const { enabled, declaredUntrusted } = await resolveEnabledPlugins(root, env);
    const registries = { ...(await readClaudeCodeInstalled(env)), ...(await readInstalledPlugins(env)) };
    const active = await loadEnabledPlugins(root, { env });
    if (!Object.keys(registries).length && !active.length) out('No Claude Code plugins installed. Try: oasis plugin marketplace add anthropics/claude-code\n');
    for (const [id, record] of Object.entries(registries)) {
      const on = enabled[id] === true;
      out((on ? '[enabled]  ' : '[disabled] ') + id + (record.source === 'claude-code' ? ' (from Claude Code)' : '') + (record.version ? ' v' + record.version : '') + '\n');
    }
    for (const plugin of active.filter((p) => p.origin === 'plugin-dir')) out('[session]  ' + plugin.name + ' (' + plugin.root + ')\n');
    for (const id of Object.keys(enabled)) if (enabled[id] && !registries[id]) out('[missing]  ' + id + ' is enabled in settings but not installed: oasis plugin install ' + id + '\n');
    for (const id of declaredUntrusted) out('[untrusted] ' + id + ' is enabled by this project; run oasis trust to allow project plugins\n');
    return;
  }
  throw new Error('Usage: oasis plugin [list | install NAME@MARKET | uninstall NAME | enable NAME | disable NAME | update [NAME] | validate [PATH] | marketplace add|list|update|remove] [--scope user|project|local]');
}
