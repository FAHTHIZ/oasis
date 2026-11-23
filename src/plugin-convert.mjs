// Plugins written for other agents, turned into Claude Code plugins that OASIS
// already runs in full (commands, skills, agents, hooks, MCP servers, options):
//
//   Gemini CLI extension   gemini-extension.json, commands/*.toml, GEMINI.md, skills/, agents/
//   Codex plugin           .codex-plugin/plugin.json, .mcp.json, skills/, hooks/
//   Agent Plugins          plugin.json ($schema agent-plugins.org), mcp.json, skills/
//   Cursor plugin          .cursor-plugin/plugin.json, rules/*.mdc, mcp.json, skills/, agents/
//   Copilot CLI plugin     .plugin/plugin.json, .github/plugin/plugin.json or a bare plugin.json
//   Kiro power             POWER.md, mcp.json, steering/*.md
//   MCP Bundle             manifest.json (manifest_version / dxt_version), .mcpb / .dxt
//   Config pack            VS Code / Copilot, Continue, Cursor, Windsurf, Cline,
//                          OpenCode, Antigravity and Gemini project files (config-packs.mjs)
//   Marketplaces           .agents/plugins/ (Codex), .cursor-plugin/, .github/plugin/, .plugin/
//                          or a root marketplace.json (Copilot CLI and Agent Plugins)
//
// Cursor and Copilot hooks keep running: hook-bridges.mjs translates their
// stdin and replies. Parts with no OASIS equivalent (Cursor Tab hooks, plugin
// variables) are listed as not carried over instead of being half-translated,
// so the approval summary says exactly what will run.
//
// The converted copy keeps every file; only manifests and Gemini's TOML commands
// are rewritten, so a plugin's scripts and assets keep working.
import { copyPluginTree } from './plugin-copy.mjs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { bridgeHookDoc } from './hook-bridges.mjs';
import { detectMcpBundle, describeMcpBundle, bundleUnsupported, convertMcpBundle, describeConfigPack, convertConfigPack } from './config-packs.mjs';
import { geminiCommandToMarkdown } from './importers.mjs';

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const slug = (value, fallback = 'plugin') => String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || fallback;

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function walk(dir, rel = '', depth = 4, out = []) {
  if (depth < 0 || out.length > 2000) return out;
  let entries = [];
  try { entries = await readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const child = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await walk(dir, child, depth - 1, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

const isAgentPluginsManifest = (manifest) => manifest && typeof manifest === 'object' && manifest.name && manifest.schemaVersion === undefined
  && (/agent-plugins/i.test(String(manifest.$schema || '')) || (manifest.extensions && typeof manifest.extensions === 'object'));

/** What kind of foreign plugin a folder holds, or null. */
export async function detectForeignPlugin(dir) {
  const gemini = await readJson(path.join(dir, 'gemini-extension.json'));
  if (gemini && gemini.name) return { format: 'gemini', label: 'Gemini CLI extension', name: slug(gemini.name), description: String(gemini.description || ''), version: String(gemini.version || ''), manifest: gemini };
  const portable = await readJson(path.join(dir, 'plugin.json'));
  if (isAgentPluginsManifest(portable)) return { format: 'agent-plugin', label: 'Agent Plugins plugin', name: slug(portable.name), description: String(portable.description || ''), version: String(portable.version || ''), manifest: portable };
  const codex = await readJson(path.join(dir, '.codex-plugin', 'plugin.json'));
  if (codex && codex.name) return { format: 'codex', label: 'Codex plugin', name: slug(codex.name), description: String(codex.description || ''), version: String(codex.version || ''), manifest: codex };
  const cursor = await readJson(path.join(dir, '.cursor-plugin', 'plugin.json'));
  if (cursor && cursor.name) return { format: 'cursor', label: 'Cursor plugin', name: slug(cursor.name), description: String(cursor.description || ''), version: String(cursor.version || ''), manifest: cursor };
  // Copilot CLI's legacy manifest locations, in the order it checks them. A bare
  // plugin.json with schemaVersion is an OASIS native package, not this.
  for (const rel of [['.plugin', 'plugin.json'], ['plugin.json'], ['.github', 'plugin', 'plugin.json']]) {
    const copilot = rel.length === 1 ? portable : await readJson(path.join(dir, ...rel));
    if (copilot && typeof copilot === 'object' && copilot.name && copilot.schemaVersion === undefined && !isAgentPluginsManifest(copilot)) {
      return { format: 'copilot', label: 'Copilot CLI plugin', name: slug(copilot.name), description: String(copilot.description || ''), version: String(copilot.version || ''), manifest: copilot, manifestFile: rel.join('/') };
    }
  }
  const bundle = await detectMcpBundle(dir);
  if (bundle) return bundle;
  const power = await readFile(path.join(dir, 'POWER.md'), 'utf8').catch(() => '');
  if (power) {
    const front = frontmatter(power);
    const name = slug(front.name || path.basename(dir), 'power');
    return { format: 'kiro-power', label: 'Kiro power', name, description: String(front.description || ''), version: String(front.version || ''), manifest: { name, displayName: front.displayName || '', keywords: front.keywords || '' } };
  }
  return null;
}

// Simple YAML frontmatter: key: value lines (quotes stripped), enough for
// POWER.md and Cursor .mdc rules. Lists stay as their raw text.
export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text));
  const out = {};
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}
const stripFrontmatter = (text) => String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

// Claude Code hook event names. Hooks written with these keep their meaning;
// Cursor (beforeShellExecution, …) and Copilot (preToolUse, …) hooks speak a
// different stdin/stdout protocol, so they are reported, not guessed at.
const CLAUDE_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'ConfigChange', 'InstructionsLoaded', 'WorktreeCreate', 'WorktreeRemove', 'Elicitation', 'ElicitationResult', 'FileChanged', 'CwdChanged', 'StopFailure']);
export function splitHookEvents(doc) {
  const hooks = doc && doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks) ? doc.hooks : null;
  if (!hooks) return { kept: null, dropped: [] };
  const kept = {}, dropped = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (CLAUDE_EVENTS.has(event) && Array.isArray(groups)) kept[event] = JSON.parse(JSON.stringify(groups), (key, value) => portableVars(value));
    else dropped.push(event);
  }
  return { kept: Object.keys(kept).length ? kept : null, dropped };
}

async function hookDoc(dir, info) {
  const m = info.manifest;
  if (m.hooks && typeof m.hooks === 'object' && !Array.isArray(m.hooks)) return m.hooks.hooks ? m.hooks : { hooks: m.hooks };
  const openai = (m.extensions && m.extensions['com.openai']) || {};
  for (const rel of [typeof m.hooks === 'string' ? m.hooks : '', typeof openai.hooks === 'string' ? openai.hooks : '', 'hooks/hooks.json', ...(info.format === 'copilot' ? ['hooks.json'] : [])]) {
    if (!rel) continue;
    const file = path.resolve(dir, rel);
    if (path.relative(dir, file).startsWith('..')) continue;
    const doc = await readJson(file);
    if (doc) return doc;
  }
  return null;
}

// Cursor and Copilot hooks run through the protocol bridge (hook-bridges.mjs):
// each one is filed under the Claude Code event that fires at the same moment.
// A relative script path is resolved against the plugin root, as both tools do.
function bridgedHooks(dir, info, doc) {
  const { dropped: foreign } = splitHookEvents(doc);
  if (!foreign.length) return { hooks: {}, dropped: [] };
  const only = { hooks: Object.fromEntries(Object.entries(doc.hooks).filter(([event]) => foreign.includes(event))) };
  const rewrite = (text, { path: isPath } = {}) => {
    const value = portableVars(String(text));
    if (isPath) return '"' + (value.startsWith('${') || path.isAbsolute(value) || !existsSync(path.join(dir, value)) ? value : underRoot(value)) + '"';
    const match = /^(\S+)([\s\S]*)$/.exec(value.trim());
    if (!match) return value;
    const [, head, rest] = match;
    // Cursor resolves a relative script against the plugin root; Copilot against
    // the repository, so there only a path the plugin itself ships is rooted.
    const ships = !head.startsWith('$') && !path.isAbsolute(head) && /[\\/]/.test(head) && existsSync(path.join(dir, head));
    const relative = ships || (info.format === 'cursor' && /^\.\.?\//.test(head));
    return relative ? '"' + underRoot(head) + '"' + rest : value;
  };
  return bridgeHookDoc(info.format, only, rewrite);
}

/** What a foreign plugin has that will not run under OASIS, in plain words. */
export async function unsupportedParts(dir, info) {
  if (info.format === 'gemini' || info.format === 'config-pack') return [];
  if (info.format === 'mcp-bundle') return bundleUnsupported(dir, info);
  const out = [];
  if (info.format === 'cursor' || info.format === 'copilot') {
    const doc = await hookDoc(dir, info);
    const { dropped } = bridgedHooks(dir, info, doc);
    if (dropped.length) out.push(info.label.replace(/ plugin$/, '') + ' hooks (' + dropped.slice(0, 6).join(', ') + ') have no matching OASIS event');
  }
  if (info.format === 'cursor' && info.manifest.variables) out.push('Cursor plugin variables');
  return out;
}

/** Plugins listed in a Codex marketplace that live inside the repository. */
export async function detectCodexMarketplace(dir) {
  const found = await detectForeignMarketplace(dir);
  return found && found.format === 'codex' ? found : null;
}

// Where other agents keep a marketplace file, in the order each checks them.
const MARKETPLACES = [
  { format: 'codex', label: 'Codex marketplace', rel: ['.agents', 'plugins', 'marketplace.json'] },
  { format: 'cursor', label: 'Cursor marketplace', rel: ['.cursor-plugin', 'marketplace.json'] },
  { format: 'copilot', label: 'Copilot CLI marketplace', rel: ['marketplace.json'] },
  { format: 'copilot', label: 'Copilot CLI marketplace', rel: ['.plugin', 'marketplace.json'] },
  { format: 'copilot', label: 'Copilot CLI marketplace', rel: ['.github', 'plugin', 'marketplace.json'] }
];

/** Plugins listed in a Codex, Cursor or Copilot marketplace that live inside the repository. */
export async function detectForeignMarketplace(dir) {
  for (const spot of MARKETPLACES) {
    const market = await readJson(path.join(dir, ...spot.rel));
    if (!market || !Array.isArray(market.plugins)) continue;
    const base = path.resolve(dir, market.metadata && typeof market.metadata.pluginRoot === 'string' ? market.metadata.pluginRoot : '.');
    const plugins = [];
    for (const entry of market.plugins) {
      if (!entry || !entry.name) continue;
      const src = typeof entry.source === 'string' ? entry.source : (entry.source && entry.source.source === 'local' ? entry.source.path : '');
      if (!src) continue;
      const resolved = path.resolve(base, src);
      if (path.relative(dir, resolved).startsWith('..')) continue;
      plugins.push({ name: slug(entry.name), description: String(entry.description || ''), path: resolved });
    }
    return { format: spot.format, label: spot.label, name: slug(market.name || spot.format + '-marketplace'), plugins };
  }
  return null;
}

// Gemini puts ${extensionPath}, ${workspacePath} and ${/} into MCP settings.
const geminiVars = (value) => typeof value === 'string'
  ? value.replace(/\$\{extensionPath\}/g, '${CLAUDE_PLUGIN_ROOT}').replace(/\$\{workspacePath\}/g, '${CLAUDE_PROJECT_DIR}').replace(/\$\{(\/|pathSeparator)\}/g, '/')
  : value;

function geminiServer(raw, settings) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (raw.httpUrl) Object.assign(out, { type: 'http', url: raw.httpUrl });
  else if (raw.url) Object.assign(out, { type: raw.type === 'http' ? 'http' : 'sse', url: raw.url });
  else if (raw.command) {
    out.command = geminiVars(String(raw.command));
    if (Array.isArray(raw.args)) out.args = raw.args.map((a) => geminiVars(String(a)));
    if (raw.cwd) out.cwd = geminiVars(String(raw.cwd));
  } else return null;
  if (raw.headers && typeof raw.headers === 'object') out.headers = Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, geminiVars(String(v))]));
  const env = raw.env && typeof raw.env === 'object' ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, geminiVars(String(v)).replace(/\$([A-Z_][A-Z0-9_]*)\b(?!\})/g, '${$1}')])) : {};
  // Gemini hands extension settings to its servers as environment variables.
  for (const setting of settings) if (out.command && !(setting.envVar in env)) env[setting.envVar] = '${user_config.' + setting.envVar + '}';
  if (Object.keys(env).length && out.command) out.env = env;
  return out;
}

// Gemini hook events -> Claude Code hook events (others have no counterpart).
const GEMINI_EVENTS = { BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', SessionStart: 'SessionStart', SessionEnd: 'SessionEnd', BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', Notification: 'Notification', PreCompress: 'PreCompact' };

function convertGeminiHooks(doc) {
  const hooks = doc && doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : null;
  if (!hooks) return null;
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const target = GEMINI_EVENTS[event];
    if (!target || !Array.isArray(groups)) continue;
    out[target] = JSON.parse(JSON.stringify(groups), (key, value) => geminiVars(value));
  }
  return Object.keys(out).length ? { hooks: out } : null;
}

// Codex and Agent Plugins resolve a relative stdio `cwd` (and a `./` command)
// against the plugin root, and expand ${PLUGIN_ROOT} / ${PLUGIN_DATA}. Claude
// Code plugins spell those ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_DATA}.
const ROOT = '${CLAUDE_PLUGIN_ROOT}';
const portableVars = (value) => typeof value === 'string'
  ? value.replace(/\$\{PLUGIN_ROOT\}/g, ROOT).replace(/\$\{PLUGIN_DATA\}/g, '${CLAUDE_PLUGIN_DATA}')
  : value;
const underRoot = (rel) => {
  // Only a leading "./" goes: ".cursor/hooks/x.sh" keeps its dot.
  const clean = path.posix.normalize(String(rel).replace(/\\/g, '/')).replace(/^\.(?:\/|$)/, '').replace(/\/$/, '');
  return clean && clean !== '.' ? ROOT + '/' + clean : ROOT;
};

function normalizeServers(doc) {
  const raw = doc && (doc.mcpServers || doc.servers);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [name, server] of Object.entries(raw)) {
    if (!server || typeof server !== 'object') continue;
    const copy = { ...server };
    if (copy.type === 'stdio') delete copy.type;
    if (copy.type === 'streamable-http' || copy.type === 'streamableHttp') copy.type = 'http';
    if (typeof copy.command === 'string') {
      copy.command = portableVars(copy.command);
      if (/^\.\.?\//.test(copy.command)) copy.command = underRoot(copy.command);
      if (Array.isArray(copy.args)) copy.args = copy.args.map(portableVars);
      if (copy.env && typeof copy.env === 'object') copy.env = Object.fromEntries(Object.entries(copy.env).map(([k, v]) => [k, portableVars(v)]));
      const cwd = typeof copy.cwd === 'string' ? portableVars(copy.cwd) : '';
      // No cwd: Agent Plugins default to the plugin root, and so do bundled servers in practice.
      copy.cwd = !cwd ? ROOT : cwd.startsWith('${') || path.isAbsolute(cwd) ? cwd : underRoot(cwd);
    }
    out[name] = copy;
  }
  return out;
}

/** A short list of what the plugin brings, for the approval summary. */
export async function describeForeignPlugin(dir, info) {
  if (info.format === 'mcp-bundle') return describeMcpBundle(dir, info);
  if (info.format === 'config-pack') return describeConfigPack(info);
  const files = await walk(dir);
  const parts = [];
  const commands = files.filter((f) => /^commands\/.+\.(toml|md)$/i.test(f)).length;
  const skills = files.filter((f) => /^skills\/[^/]+\/SKILL\.md$/i.test(f)).length;
  const agents = files.filter((f) => /^agents\/.+\.md$/i.test(f)).length;
  if (commands) parts.push(commands + ' command' + (commands === 1 ? '' : 's'));
  if (skills) parts.push(skills + ' skill' + (skills === 1 ? '' : 's'));
  if (agents) parts.push(agents + ' agent' + (agents === 1 ? '' : 's'));
  const servers = info.format === 'gemini' ? Object.keys(info.manifest.mcpServers || {}) : Object.keys(await foreignServers(dir, info));
  if (servers.length) parts.push(servers.length + ' MCP server' + (servers.length === 1 ? '' : 's') + ' (they run when sessions start)');
  if (info.format === 'cursor' || info.format === 'copilot') {
    const doc = await hookDoc(dir, info);
    const bridged = Object.keys(bridgedHooks(dir, info, doc).hooks).length;
    if (splitHookEvents(doc).kept || bridged) parts.push('hooks (they run commands on events' + (bridged ? '; ' + (info.format === 'cursor' ? 'Cursor' : 'Copilot') + ' hooks run through the OASIS protocol bridge' : '') + ')');
  } else if (files.includes('hooks/hooks.json') || info.manifest.hooks) parts.push('hooks (they run commands on events)');
  const rules = files.filter((f) => /^rules\/.+\.(mdc|md)$/i.test(f)).length;
  if (info.format === 'cursor' && rules) parts.push(rules + ' rule' + (rules === 1 ? '' : 's') + ' (as skills)');
  if (info.format === 'kiro-power') parts.push('its POWER.md guide' + (files.some((f) => /^steering\/.+\.md$/i.test(f)) ? ' and steering files' : '') + ' (as a skill)');
  if (info.format === 'copilot' && !skills && files.includes('SKILL.md')) parts.push('1 skill');
  if (info.format === 'gemini' && contextFiles(info.manifest, files).length) parts.push('its ' + contextFiles(info.manifest, files).join(', ') + ' instructions');
  const settings = geminiSettings(info.manifest);
  if (settings.length) parts.push('settings to fill in: ' + settings.map((s) => s.envVar).join(', '));
  return parts;
}

function geminiSettings(manifest) {
  return Array.isArray(manifest.settings) ? manifest.settings.filter((s) => s && /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s.envVar || ''))).map((s) => ({ envVar: String(s.envVar), name: String(s.name || s.envVar), description: String(s.description || ''), sensitive: Boolean(s.sensitive) })) : [];
}

function contextFiles(manifest, files) {
  const named = manifest.contextFileName ? [].concat(manifest.contextFileName).map(String) : ['GEMINI.md'];
  return named.filter((name) => files.includes(name.replace(/^\.\//, '')));
}

async function foreignServers(dir, info) {
  const m = info.manifest;
  const openai = (m.extensions && m.extensions['com.openai']) || {};
  if (m.mcpServers && typeof m.mcpServers === 'object') return normalizeServers(m);
  for (const rel of [typeof m.mcpServers === 'string' ? m.mcpServers : '', typeof openai.mcpServers === 'string' ? openai.mcpServers : '', '.mcp.json', 'mcp.json', '.github/mcp.json']) {
    if (!rel) continue;
    const file = path.resolve(dir, rel);
    if (path.relative(dir, file).startsWith('..')) continue;
    const doc = await readJson(file);
    if (doc) return normalizeServers(doc);
  }
  return {};
}

/** Copy a foreign plugin to dest as a Claude Code plugin. Returns its name. */
export async function convertToClaudePlugin(srcDir, destDir, info) {
  await rm(destDir, { recursive: true, force: true });
  await copyPluginTree(srcDir, destDir);
  const files = await walk(destDir);
  const m = info.manifest;
  const name = NAME.test(info.name) ? info.name : slug(info.name);
  const manifest = { name, ...(info.version ? { version: info.version } : {}), ...(info.description ? { description: info.description.slice(0, 500) } : {}) };
  if (info.format === 'mcp-bundle') await convertMcpBundle(destDir, info, manifest);
  else if (info.format === 'config-pack') {
    // Copied VS Code agent files (agents/*.agent.md) would load as agents under
    // the wrong names; the converted copies replace them.
    for (const rel of files.filter((f) => /^agents\/[^/]+\.(agent|chatmode)\.md$/i.test(f))) await rm(path.join(destDir, rel), { force: true });
    await convertConfigPack(destDir, info, manifest, writeSkill);
    for (const { protocol, doc } of info.found.hookDocs || []) {
      const { hooks } = bridgedHooks(destDir, { format: protocol }, doc);
      for (const [event, groups] of Object.entries(hooks)) (((manifest.hooks ||= {}))[event] ||= []).push(...groups);
    }
  } else if (info.format === 'gemini') {
    const settings = geminiSettings(m);
    const servers = {};
    for (const [key, raw] of Object.entries(m.mcpServers || {})) { const server = geminiServer(raw, settings); if (server) servers[key] = server; }
    if (Object.keys(servers).length) manifest.mcpServers = servers;
    if (settings.length) manifest.userConfig = Object.fromEntries(settings.map((s) => [s.envVar, { type: 'string', title: s.name, description: s.description, sensitive: s.sensitive }]));
    // TOML commands become Markdown commands; the TOML stays behind for reference.
    for (const rel of files.filter((f) => /^commands\/.+\.toml$/i.test(f))) {
      const md = geminiCommandToMarkdown(await readFile(path.join(destDir, rel), 'utf8').catch(() => ''));
      // Gemini names nested commands group:cmd; Claude Code plugins use one level.
      if (md) await writeFile(path.join(destDir, 'commands', rel.slice('commands/'.length).replace(/\.toml$/i, '').split('/').join('-') + '.md'), md);
    }
    // Gemini hooks use their own event names: rewrite them, drop the original.
    const hooksDoc = await readJson(path.join(destDir, 'hooks', 'hooks.json'));
    if (hooksDoc) {
      const converted = convertGeminiHooks(hooksDoc);
      await rm(path.join(destDir, 'hooks', 'hooks.json'), { force: true });
      if (converted) manifest.hooks = converted;
    }
    // GEMINI.md is always-on context in Gemini; here it becomes a skill the agent reads when it applies.
    const context = contextFiles(m, files);
    if (context.length) {
      const body = (await Promise.all(context.map((rel) => readFile(path.join(destDir, rel), 'utf8').catch(() => '')))).join('\n\n');
      const dir = path.join(destDir, 'skills', name + '-guide');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '-guide\ndescription: ' + JSON.stringify(('How to use the ' + name + ' extension' + (info.description ? ' (' + info.description + ')' : '') + '. Read this before using its tools or commands.').slice(0, 900)) + '\n---\n\n' + body.trim() + '\n');
    }
  } else {
    // A root .mcp.json is read by the plugin loader already: rewrite it in place
    // with plugin-root paths. Servers anywhere else are inlined in the manifest.
    const rootDoc = await readJson(path.join(destDir, '.mcp.json'));
    if (rootDoc) {
      const converted = normalizeServers(rootDoc);
      if (Object.keys(converted).length) await writeFile(path.join(destDir, '.mcp.json'), JSON.stringify({ mcpServers: converted }, null, 2) + '\n');
    }
    const servers = rootDoc ? {} : await foreignServers(destDir, info);
    if (Object.keys(servers).length) manifest.mcpServers = servers;
    const openai = (m.extensions && m.extensions['com.openai']) || {};
    const hooksRel = typeof m.hooks === 'string' ? m.hooks : (typeof openai.hooks === 'string' ? openai.hooks : '');
    if (m.hooks && typeof m.hooks === 'object') manifest.hooks = m.hooks;
    else if (hooksRel && path.posix.normalize(hooksRel.replace(/^\.\//, '')) !== 'hooks/hooks.json') manifest.hooks = './' + hooksRel.replace(/^\.\//, '');
    const skillsRel = typeof m.skills === 'string' ? m.skills.replace(/^\.\//, '').replace(/\/$/, '') : '';
    if (skillsRel && skillsRel !== 'skills') manifest.skills = './' + skillsRel;
    if (info.format === 'cursor' || info.format === 'copilot') await adaptCursorOrCopilot(destDir, info, manifest, files);
    if (info.format === 'kiro-power') await adaptKiroPower(destDir, info, files);
  }
  await mkdir(path.join(destDir, '.claude-plugin'), { recursive: true });
  await writeFile(path.join(destDir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  return name;
}

const insideRel = (value) => {
  if (typeof value !== 'string') return '';
  const clean = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '');
  return clean && clean !== '.' && !clean.startsWith('..') && !path.posix.isAbsolute(clean) ? clean : '';
};

async function writeSkill(destDir, name, description, body) {
  const dir = path.join(destDir, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + JSON.stringify(String(description).replace(/\s+/g, ' ').slice(0, 900)) + '\n---\n\n' + String(body).trim() + '\n');
  return dir;
}

// Cursor and Copilot CLI plugins share Claude Code's folder layout; what
// differs is hooks, Cursor rules, a few file names and custom component paths.
async function adaptCursorOrCopilot(destDir, info, manifest, files) {
  const m = info.manifest;
  for (const key of ['commands', 'agents']) {
    const rels = [].concat(m[key] || []).map(insideRel).filter(Boolean);
    if (rels.length && !(rels.length === 1 && rels[0] === key)) manifest[key] = rels.map((rel) => './' + rel);
  }
    // Hooks under Cursor/Copilot event names run through the protocol bridge.
  const doc = await hookDoc(destDir, info);
  const { kept } = splitHookEvents(doc);
  const bridged = bridgedHooks(destDir, info, doc).hooks;
  delete manifest.hooks;
  for (const rel of ['hooks/hooks.json', 'hooks.json']) await rm(path.join(destDir, rel), { force: true });
  const merged = { ...(kept || {}) };
  for (const [event, groups] of Object.entries(bridged)) merged[event] = [...(merged[event] || []), ...groups];
  if (Object.keys(merged).length) manifest.hooks = merged;
  if (info.format === 'copilot') {
    if (!manifest.mcpServers && !(await readJson(path.join(destDir, '.mcp.json')))) {
      const servers = normalizeServers(await readJson(path.join(destDir, '.github', 'mcp.json')));
      if (Object.keys(servers).length) manifest.mcpServers = servers;
    }
    if (files.includes('lsp.json') && !files.includes('.lsp.json')) await writeFile(path.join(destDir, '.lsp.json'), await readFile(path.join(destDir, 'lsp.json'), 'utf8'));
    if (m.lspServers && typeof m.lspServers === 'object') manifest.lspServers = m.lspServers;
    // A root SKILL.md (Copilot's one-skill plugin) is already read by the plugin loader.
    return;
  }
  // Cursor rules (.mdc) become skills: the agent reads them when they apply.
  const ruleDirs = [].concat(m.rules || 'rules').map(insideRel).filter(Boolean);
  for (const rel of files.filter((f) => /\.(mdc|md)$/i.test(f) && ruleDirs.some((dir) => f.startsWith(dir + '/')))) {
    const text = await readFile(path.join(destDir, rel), 'utf8').catch(() => '');
    if (!text.trim()) continue;
    const front = frontmatter(text);
    const base = slug(path.posix.basename(rel).replace(/\.(mdc|md)$/i, ''), 'rule');
    const always = /^true$/i.test(String(front.alwaysApply || ''));
    const scope = front.globs ? ' Applies to files matching ' + front.globs + '.' : '';
    const description = (front.description || 'Project rule ' + base + ' from the ' + manifest.name + ' plugin') + '.' + scope + (always ? ' Always follow this rule.' : '');
    await writeSkill(destDir, slug(manifest.name + '-rule-' + base).slice(0, 64), description, stripFrontmatter(text));
  }
  const skillsRels = [].concat(m.skills || []).map(insideRel).filter(Boolean);
  if (skillsRels.length > 1) manifest.skills = skillsRels.map((rel) => './' + rel);
}

// A Kiro power is a POWER.md guide (plus optional steering files) next to an
// mcp.json. The guide becomes a skill; steering files go with it.
async function adaptKiroPower(destDir, info, files) {
  const text = await readFile(path.join(destDir, 'POWER.md'), 'utf8').catch(() => '');
  const front = frontmatter(text);
  const steering = files.filter((f) => /^steering\/.+\.md$/i.test(f));
  const keywords = String(front.keywords || '').replace(/[[\]"']/g, '').trim();
  const description = (info.description || 'How to use the ' + (front.displayName || info.name) + ' power') + (keywords ? ' Keywords: ' + keywords + '.' : '');
  const list = steering.length ? '\n\n## Steering files\n\nRead the one that matches the task:\n\n' + steering.map((f) => '- ' + f).join('\n') + '\n' : '';
  const dir = await writeSkill(destDir, info.name, description, stripFrontmatter(text) + list);
  for (const rel of steering) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), await readFile(path.join(destDir, rel), 'utf8'));
  }
}

// Gemini CLI installs GitHub extensions from the release marked Latest when it
// has archives named {platform}.{arch}.{name}.{ext}, {platform}.{name}.{ext} or a
// single generic asset; those archives hold built files the source lacks.
export function pickReleaseAsset(assets, { platform = process.platform, arch = process.arch } = {}) {
  const archives = (assets || []).filter((a) => a && /\.(tar\.gz|tgz|zip)$/i.test(String(a.name || '')));
  const lower = (a) => String(a.name).toLowerCase();
  return archives.find((a) => lower(a).startsWith(platform + '.' + arch + '.'))
    || archives.find((a) => lower(a).startsWith(platform + '.') && !/^(darwin|linux|win32)\.(x64|arm64)\./.test(lower(a)))
    || (archives.length === 1 && !/^(darwin|linux|win32)\./.test(lower(archives[0])) ? archives[0] : null);
}

export async function fetchGeminiRelease(owner, repo, { env = process.env, fetchImpl = globalThis.fetch, ref = '' } = {}) {
  if (!fetchImpl) return null;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'oasis' };
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) headers.authorization = 'Bearer ' + token;
  const api = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/' + (ref ? 'tags/' + encodeURIComponent(ref) : 'latest');
  let release;
  try {
    const response = await fetchImpl(api, { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    release = await response.json();
  } catch { return null; }
  const asset = pickReleaseAsset(release && release.assets);
  if (!asset || !asset.browser_download_url || Number(asset.size) > 200 * 1024 * 1024) return null;
  const { mkdtemp } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-gemini-release-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const response = await fetchImpl(asset.browser_download_url, { headers: { 'user-agent': 'oasis', accept: 'application/octet-stream' }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('download failed');
    const archive = path.join(dir, /\.zip$/i.test(asset.name) ? 'asset.zip' : 'asset.tar.gz');
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const out = path.join(dir, 'x');
    await mkdir(out);
    const { execFile } = await import('node:child_process');
    // bsdtar on Windows 10+ and macOS reads zip too; GNU tar falls back to unzip.
    const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000 }, (error) => error ? reject(error) : resolve()));
    if (/\.zip$/i.test(archive)) await run('tar', ['-xf', archive, '-C', out]).catch(() => run('unzip', ['-q', archive, '-d', out]));
    else await run('tar', ['-xzf', archive, '-C', out]);
    // Refuse archives whose entries escape the folder (tar strips them, but check).
    let root = out;
    if (!(await readJson(path.join(out, 'gemini-extension.json')))) {
      const entries = await readdir(out, { withFileTypes: true });
      const only = entries.length === 1 && entries[0].isDirectory() ? path.join(out, entries[0].name) : '';
      if (!only || !(await readJson(path.join(only, 'gemini-extension.json')))) throw new Error('no gemini-extension.json in the release archive');
      root = only;
    }
    return { dir: root, tag: String(release.tag_name || ''), asset: asset.name, cleanup };
  } catch {
    await cleanup();
    return null;
  }
}
