// Plugins written for other agents, turned into Claude Code plugins that OASIS
// already runs in full (commands, skills, agents, hooks, MCP servers, options):
//
//   Gemini CLI extension   gemini-extension.json, commands/*.toml, GEMINI.md, skills/, agents/
//   Codex plugin           .codex-plugin/plugin.json, .mcp.json, skills/, hooks/
//   Agent Plugins          plugin.json ($schema agent-plugins.org), mcp.json, skills/
//   Codex marketplace      .agents/plugins/marketplace.json (local plugin entries)
//
// The converted copy keeps every file; only manifests and Gemini's TOML commands
// are rewritten, so a plugin's scripts and assets keep working.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  return null;
}

/** Plugins listed in a Codex marketplace that live inside the repository. */
export async function detectCodexMarketplace(dir) {
  const market = await readJson(path.join(dir, '.agents', 'plugins', 'marketplace.json'));
  if (!market || !Array.isArray(market.plugins)) return null;
  const plugins = [];
  for (const entry of market.plugins) {
    if (!entry || !entry.name) continue;
    const src = typeof entry.source === 'string' ? entry.source : (entry.source && entry.source.source === 'local' ? entry.source.path : '');
    if (!src) continue;
    const resolved = path.resolve(dir, src);
    if (path.relative(dir, resolved).startsWith('..')) continue;
    plugins.push({ name: slug(entry.name), description: String(entry.description || ''), path: resolved });
  }
  return { name: slug(market.name || 'codex-marketplace'), plugins };
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

function normalizeServers(doc) {
  const raw = doc && (doc.mcpServers || doc.servers);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [name, server] of Object.entries(raw)) {
    if (!server || typeof server !== 'object') continue;
    const copy = { ...server };
    if (copy.type === 'stdio') delete copy.type;
    if (copy.type === 'streamable-http' || copy.type === 'streamableHttp') copy.type = 'http';
    out[name] = copy;
  }
  return out;
}

/** A short list of what the plugin brings, for the approval summary. */
export async function describeForeignPlugin(dir, info) {
  const files = await walk(dir);
  const parts = [];
  const commands = files.filter((f) => /^commands\/.+\.(toml|md)$/i.test(f)).length;
  const skills = files.filter((f) => /^skills\/[^/]+\/SKILL\.md$/i.test(f)).length;
  const agents = files.filter((f) => /^agents\/.+\.md$/i.test(f)).length;
  if (commands) parts.push(commands + ' commands');
  if (skills) parts.push(skills + ' skills');
  if (agents) parts.push(agents + ' agents');
  const servers = info.format === 'gemini' ? Object.keys(info.manifest.mcpServers || {}) : Object.keys(await foreignServers(dir, info));
  if (servers.length) parts.push(servers.length + ' MCP server' + (servers.length === 1 ? '' : 's') + ' (they run when sessions start)');
  if (files.includes('hooks/hooks.json') || info.manifest.hooks) parts.push('hooks (they run commands on events)');
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
  for (const rel of [typeof m.mcpServers === 'string' ? m.mcpServers : '', typeof openai.mcpServers === 'string' ? openai.mcpServers : '', '.mcp.json', 'mcp.json']) {
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
  await cp(srcDir, destDir, { recursive: true, filter: (file) => !file.split(path.sep).includes('.git') });
  const files = await walk(destDir);
  const m = info.manifest;
  const name = NAME.test(info.name) ? info.name : slug(info.name);
  const manifest = { name, ...(info.version ? { version: info.version } : {}), ...(info.description ? { description: info.description.slice(0, 500) } : {}) };
  if (info.format === 'gemini') {
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
    // A root .mcp.json is read by the plugin loader already; inline anything else.
    const hasDefault = Boolean(await readJson(path.join(destDir, '.mcp.json')));
    const servers = hasDefault ? {} : await foreignServers(destDir, info);
    if (Object.keys(servers).length) manifest.mcpServers = servers;
    const openai = (m.extensions && m.extensions['com.openai']) || {};
    const hooksRel = typeof m.hooks === 'string' ? m.hooks : (typeof openai.hooks === 'string' ? openai.hooks : '');
    if (m.hooks && typeof m.hooks === 'object') manifest.hooks = m.hooks;
    else if (hooksRel && path.posix.normalize(hooksRel.replace(/^\.\//, '')) !== 'hooks/hooks.json') manifest.hooks = './' + hooksRel.replace(/^\.\//, '');
    const skillsRel = typeof m.skills === 'string' ? m.skills.replace(/^\.\//, '').replace(/\/$/, '') : '';
    if (skillsRel && skillsRel !== 'skills') manifest.skills = './' + skillsRel;
  }
  await mkdir(path.join(destDir, '.claude-plugin'), { recursive: true });
  await writeFile(path.join(destDir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  return name;
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
