// oasis plugin export: write one plugin so every agent can install it.
//
// The source is an OASIS or Claude Code plugin, or anything `oasis add`
// converts (a Codex, Gemini CLI, Cursor, Copilot CLI or Kiro plugin, an MCP
// Bundle, a config pack). The output is one folder with a manifest for each
// target next to the shared parts:
//
//   claude   .claude-plugin/plugin.json  (OASIS and Claude Code)
//   codex    .codex-plugin/plugin.json   commands and agents also as skills
//   gemini   gemini-extension.json       commands as TOML, hooks under Gemini
//                                        event and tool names, options as settings
//   cursor   .cursor-plugin/plugin.json  options as variables
//   copilot  .plugin/plugin.json         agents as *.agent.md
//
// Skills (skills/*/SKILL.md) and MCP servers are the shared core. Every
// target gets a report line for what it carries, translates and leaves out.

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyPluginTree } from './plugin-copy.mjs';
import { splitFrontMatter } from './frontmatter.mjs';

export const EXPORT_TARGETS = Object.freeze(['claude', 'codex', 'gemini', 'cursor', 'copilot']);

const readJson = async (file) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
};
const exists = (file) => stat(file).then(() => true, () => false);
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const slug = (value, fallback = 'item') => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || fallback;

async function markdownIn(dir, prefix = '', depth = 0) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3 && !entry.name.startsWith('.')) out.push(...await markdownIn(full, prefix + entry.name + '/', depth + 1));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push({ file: full, rel: prefix + entry.name, name: (prefix + entry.name.replace(/\.md$/i, '')).split('/').join(':') });
  }
  return out;
}

async function skillDirs(root) {
  const out = [];
  let entries;
  try { entries = await readdir(path.join(root, 'skills'), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) if (entry.isDirectory() && await exists(path.join(root, 'skills', entry.name, 'SKILL.md'))) out.push(entry.name);
  return out.sort();
}

// Bring the source into Claude Code plugin form (converting it if it is
// another agent's format) and return { dir, manifest, cleanup }.
async function canonical(source) {
  const dir = path.resolve(source);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error('No plugin folder at ' + source + '.');
  for (const folder of ['.oasis-plugin', '.claude-plugin']) {
    const manifest = await readJson(path.join(dir, folder, 'plugin.json'));
    if (manifest && manifest.name) return { dir, manifest, from: folder === '.oasis-plugin' ? 'OASIS plugin' : 'Claude Code plugin', cleanup: async () => {} };
  }
  const convert = await import('./plugin-convert.mjs');
  let info = await convert.detectForeignPlugin(dir);
  if (!info) info = await (await import('./config-packs.mjs')).detectConfigPack(dir);
  if (!info) throw new Error(source + ' is not a plugin OASIS can read (no .claude-plugin/plugin.json, .oasis-plugin/plugin.json or another agent\'s plugin manifest).');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'oasis-export-'));
  const out = path.join(temp, 'plugin');
  await convert.convertToClaudePlugin(dir, out, info);
  return { dir: out, manifest: await readJson(path.join(out, '.claude-plugin', 'plugin.json')), from: info.label, cleanup: () => rm(temp, { recursive: true, force: true }) };
}

// Every MCP server the plugin declares, in one { name: spec } map.
async function collectServers(dir, manifest) {
  const servers = {};
  const take = (doc) => { const map = doc && typeof doc === 'object' ? (doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : doc) : {}; for (const [k, v] of Object.entries(map)) if (v && typeof v === 'object' && (v.command || v.url)) servers[k] = v; };
  take(await readJson(path.join(dir, '.mcp.json')));
  for (const item of [].concat(manifest.mcpServers || [])) {
    if (typeof item === 'string') take(await readJson(path.join(dir, item.replace(/^\.\//, ''))));
    else take(item);
  }
  return servers;
}

async function collectHooks(dir, manifest) {
  if (manifest.hooks && typeof manifest.hooks === 'object') return manifest.hooks.hooks && typeof manifest.hooks.hooks === 'object' ? manifest.hooks.hooks : manifest.hooks;
  const rel = typeof manifest.hooks === 'string' ? manifest.hooks.replace(/^\.\//, '') : 'hooks/hooks.json';
  const doc = await readJson(path.join(dir, rel));
  return doc && typeof doc === 'object' ? (doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : doc) : {};
}

const mapStrings = (value, fn) => JSON.parse(JSON.stringify(value), (key, v) => typeof v === 'string' ? fn(v) : v);

// ---------- Gemini CLI ----------

const GEMINI_EVENTS = { PreToolUse: 'BeforeTool', PostToolUse: 'AfterTool', SessionStart: 'SessionStart', SessionEnd: 'SessionEnd', UserPromptSubmit: 'BeforeAgent', Stop: 'AfterAgent', Notification: 'Notification', PreCompact: 'PreCompress' };
const GEMINI_TOOLS = { Bash: 'run_shell_command', Read: 'read_file', Write: 'write_file', Edit: 'replace', MultiEdit: 'replace', Glob: 'glob', Grep: 'grep_search', LS: 'list_directory', WebFetch: 'web_fetch', WebSearch: 'google_web_search', TodoWrite: 'write_todos' };

const envName = (key) => String(key).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const geminiVars = (text) => text
  .replace(/\$\{(?:CLAUDE|OASIS)_PLUGIN_ROOT\}/g, '${extensionPath}')
  .replace(/\$\{(?:CLAUDE|OASIS)_PROJECT_DIR\}/g, '${workspacePath}')
  .replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, key) => '$' + envName(key));

export function geminiMatcher(matcher) {
  if (!matcher || matcher === '*') return matcher;
  return String(matcher).split('|').map((part) => GEMINI_TOOLS[part] || part.replace(/^mcp__([^_]+)__/, '$1__')).join('|');
}

function geminiHooks(hooks) {
  const out = {};
  const dropped = [];
  for (const [event, groups] of Object.entries(hooks || {})) {
    const target = GEMINI_EVENTS[event];
    if (!target) { dropped.push(event); continue; }
    out[target] = (Array.isArray(groups) ? groups : []).map((group) => ({
      ...(group.matcher ? { matcher: geminiMatcher(group.matcher) } : {}),
      hooks: (group.hooks || []).filter((hook) => hook && hook.type !== 'prompt' && hook.type !== 'agent' && hook.command).map((hook) => ({
        type: 'command', command: geminiVars(String(hook.command)), ...(hook.timeout ? { timeout: Number(hook.timeout) * 1000 } : {})
      }))
    })).filter((group) => group.hooks.length);
    if (!out[target].length) delete out[target];
  }
  return { hooks: out, dropped };
}

export function commandToGeminiToml(text) {
  const { data, body } = splitFrontMatter(text);
  const prompt = String(body).trim().replace(/\$ARGUMENTS\b/g, '{{args}}').replace(/\$\{?([1-9])\}?/g, '{{args}}');
  const quote = (s) => '"""\n' + s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"') + '\n"""';
  return (data && data.description ? 'description = ' + JSON.stringify(String(data.description)) + '\n' : '') + 'prompt = ' + quote(prompt) + '\n';
}

// ---------- targets ----------

const baseManifest = (m) => Object.fromEntries(Object.entries({
  name: m.name, version: m.version, description: m.description, author: m.author && typeof m.author === 'object' ? m.author : undefined,
  homepage: m.homepage, repository: typeof m.repository === 'string' ? m.repository : undefined, license: m.license, keywords: Array.isArray(m.keywords) ? m.keywords : undefined
}).filter(([, v]) => v !== undefined && v !== ''));

/**
 * Export a plugin for other agents. Returns { dir, from, report: [{ target, file, carried, translated, dropped }] }.
 * @param {string} source plugin folder
 * @param {{ out: string, targets?: string[], force?: boolean }} options
 */
export async function exportPlugin(source, options = {}) {
  const targets = [...new Set((options.targets && options.targets.length ? options.targets : EXPORT_TARGETS).map((t) => String(t).toLowerCase()))];
  for (const t of targets) if (!EXPORT_TARGETS.includes(t)) throw new Error('Unknown export target "' + t + '". Use ' + EXPORT_TARGETS.join(', ') + ' or all.');
  if (!options.out) throw new Error('Choose an output folder: --out DIR');
  const out = path.resolve(options.out);
  if (path.resolve(source) === out) throw new Error('The output folder must differ from the source.');
  if (await exists(out)) {
    if (!options.force && (await readdir(out)).length) throw new Error(options.out + ' is not empty; pass --force to replace it.');
    await rm(out, { recursive: true, force: true });
  }
  const src = await canonical(source);
  try {
    const m = src.manifest;
    await copyPluginTree(src.dir, out);
    const servers = await collectServers(out, m);
    const hooks = await collectHooks(out, m);
    const commands = await markdownIn(path.join(out, 'commands'));
    const agents = await markdownIn(path.join(out, 'agents'));
    const skills = await skillDirs(out);
    const userConfig = m.userConfig && typeof m.userConfig === 'object' ? m.userConfig : {};
    const hasHooks = Object.keys(hooks).length > 0;
    const report = [];
    const extra = ['lspServers', 'monitors', 'outputStyles'].filter((k) => m[k]);

    // Shared parts in one place: servers in .mcp.json, Claude-format hooks in
    // hooks/claude-hooks.json so Gemini and Cursor (which read hooks/hooks.json
    // in their own formats) do not misread them.
    if (Object.keys(servers).length) await writeFile(path.join(out, '.mcp.json'), json({ mcpServers: servers }));
    await rm(path.join(out, 'hooks', 'hooks.json'), { force: true });
    if (hasHooks) { await mkdir(path.join(out, 'hooks'), { recursive: true }); await writeFile(path.join(out, 'hooks', 'claude-hooks.json'), json({ hooks })); }
    const claudeManifest = { ...m };
    delete claudeManifest.mcpServers;
    if (hasHooks) claudeManifest.hooks = './hooks/claude-hooks.json'; else delete claudeManifest.hooks;
    for (const folder of ['.oasis-plugin', '.claude-plugin']) await rm(path.join(out, folder, 'plugin.json'), { force: true });
    const counts = { commands: commands.length, agents: agents.length, skills: skills.length, servers: Object.keys(servers).length, hooks: Object.keys(hooks).length, options: Object.keys(userConfig).length };
    const nouns = { commands: 'command', agents: 'agent', skills: 'skill', servers: 'MCP server', hooks: 'hook event', options: 'option' };
    const carried = (keys) => keys.filter((k) => counts[k]).map((k) => counts[k] + ' ' + nouns[k] + (counts[k] === 1 ? '' : 's'));

    if (targets.includes('claude')) {
      await mkdir(path.join(out, '.claude-plugin'), { recursive: true });
      await writeFile(path.join(out, '.claude-plugin', 'plugin.json'), json(claudeManifest));
      report.push({ target: 'claude', label: 'OASIS / Claude Code', file: '.claude-plugin/plugin.json', carried: carried(['commands', 'agents', 'skills', 'servers', 'hooks', 'options']).concat(extra), translated: [], dropped: [] });
    }

    if (targets.includes('codex')) {
      // Codex plugins carry skills, MCP servers and hooks. Commands and agents
      // become skills in a Codex-only folder so the other agents do not list them twice.
      const translated = [];
      let skillsRel = './skills/';
      if (commands.length || agents.length) {
        skillsRel = './codex/skills/';
        const dest = path.join(out, 'codex', 'skills');
        await mkdir(dest, { recursive: true });
        for (const name of skills) await copyPluginTree(path.join(out, 'skills', name), path.join(dest, name));
        const used = new Set(skills);
        const add = async (item, kind) => {
          const { data, body } = splitFrontMatter(await readFile(item.file, 'utf8'));
          let name = slug((kind === 'agent' ? 'agent-' : '') + item.name.replace(/:/g, '-'));
          while (used.has(name)) name = slug(name + '-' + kind);
          used.add(name);
          const description = (data.description ? String(data.description) : (kind === 'agent' ? 'Act as the ' + item.name + ' agent' : 'The /' + item.name + ' command')) + (kind === 'command' ? ' (use when the user asks for /' + item.name + ')' : ' (use when the task calls for this specialist)');
          const text = kind === 'command' ? String(body).trim().replace(/\$ARGUMENTS\b/g, 'the user\'s request') : 'You are acting as this agent for the current task.\n\n' + String(body).trim();
          await mkdir(path.join(dest, name), { recursive: true });
          await writeFile(path.join(dest, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + JSON.stringify(description.replace(/\s+/g, ' ').slice(0, 900)) + '\n---\n\n' + text + '\n');
        };
        for (const item of commands) await add(item, 'command');
        for (const item of agents) await add(item, 'agent');
        if (commands.length) translated.push(commands.length + ' commands as skills');
        if (agents.length) translated.push(agents.length + ' agents as skills');
      }
      const manifest = { ...baseManifest(m), skills: skillsRel, ...(counts.servers ? { mcpServers: './.mcp.json' } : {}), ...(hasHooks ? { hooks: './hooks/claude-hooks.json' } : {}) };
      await mkdir(path.join(out, '.codex-plugin'), { recursive: true });
      await writeFile(path.join(out, '.codex-plugin', 'plugin.json'), json(manifest));
      report.push({ target: 'codex', label: 'Codex', file: '.codex-plugin/plugin.json', carried: carried(['skills', 'servers', 'hooks']), translated, dropped: [...(counts.options ? ['options (set the environment variables the servers read)'] : []), ...extra] });
    }

    if (targets.includes('gemini')) {
      const translated = [];
      const dropped = [...extra];
      const settings = Object.entries(userConfig).map(([key, option]) => ({ name: String((option && option.title) || key), description: String((option && option.description) || key), envVar: envName(key), ...(option && option.sensitive ? { sensitive: true } : {}) }));
      const geminiServers = mapStrings(servers, geminiVars);
      for (const spec of Object.values(geminiServers)) {
        if (spec.type === 'http' || spec.type === 'streamable-http') { spec.httpUrl = spec.url; delete spec.url; }
        delete spec.type;
      }
      for (const item of commands) {
        const dest = path.join(out, 'commands', item.rel.replace(/\.md$/i, '.toml'));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, commandToGeminiToml(await readFile(item.file, 'utf8')));
      }
      if (commands.length) translated.push(commands.length + ' commands as TOML');
      let hookCount = 0;
      if (hasHooks) {
        const converted = geminiHooks(hooks);
        hookCount = Object.keys(converted.hooks).length;
        if (hookCount) {
          await mkdir(path.join(out, 'hooks'), { recursive: true });
          await writeFile(path.join(out, 'hooks', 'hooks.json'), json({ hooks: converted.hooks }));
          translated.push(hookCount + ' hook events under Gemini names');
        }
        if (converted.dropped.length) dropped.push('hook events ' + converted.dropped.join(', '));
      }
      if (settings.length) translated.push(settings.length + ' options as settings');
      const manifest = { ...baseManifest(m), ...(Object.keys(geminiServers).length ? { mcpServers: geminiServers } : {}), ...(settings.length ? { settings } : {}) };
      delete manifest.author; delete manifest.homepage; delete manifest.repository; delete manifest.license; delete manifest.keywords;
      await writeFile(path.join(out, 'gemini-extension.json'), json(manifest));
      report.push({ target: 'gemini', label: 'Gemini CLI', file: 'gemini-extension.json', carried: carried(['skills', 'agents', 'servers']), translated, dropped });
    }

    if (targets.includes('cursor')) {
      // Cursor expands ${CLAUDE_PLUGIN_ROOT} in mcp.json; options become
      // dashboard variables substituted as ${NAME}.
      const variables = Object.keys(userConfig).length ? { type: 'object', properties: Object.fromEntries(Object.entries(userConfig).map(([key, option]) => [key, { type: 'string', ...(option && option.description ? { description: String(option.description) } : {}) }])) } : null;
      const cursorServers = mapStrings(servers, (v) => v.replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}').replace(/\$\{OASIS_PLUGIN_ROOT\}/g, '${CURSOR_PLUGIN_ROOT}').replace(/\$\{(?:CLAUDE|OASIS)_PROJECT_DIR\}/g, '${workspaceFolder}'));
      if (counts.servers) await writeFile(path.join(out, 'mcp.json'), json({ mcpServers: cursorServers }));
      const manifest = { ...baseManifest(m), ...(variables ? { variables } : {}) };
      await mkdir(path.join(out, '.cursor-plugin'), { recursive: true });
      await writeFile(path.join(out, '.cursor-plugin', 'plugin.json'), json(manifest));
      report.push({ target: 'cursor', label: 'Cursor', file: '.cursor-plugin/plugin.json', carried: carried(['commands', 'agents', 'skills', 'servers']), translated: variables ? [counts.options + ' options as variables'] : [], dropped: [...(hasHooks ? ['hooks (Cursor hooks read a different protocol)'] : []), ...extra] });
    }

    if (targets.includes('copilot')) {
      // Copilot CLI reads agents as *.agent.md; copies go in a Copilot-only folder.
      const translated = [];
      let agentsRel;
      if (agents.length) {
        agentsRel = './copilot/agents/';
        for (const item of agents) {
          const dest = path.join(out, 'copilot', 'agents', item.rel.replace(/\//g, '-').replace(/\.md$/i, '.agent.md'));
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, await readFile(item.file, 'utf8'));
        }
        translated.push(agents.length + ' agents as .agent.md');
      }
      const manifest = { ...baseManifest(m), ...(agentsRel ? { agents: agentsRel } : {}), skills: './skills/', ...(commands.length ? { commands: './commands/' } : {}), ...(counts.servers ? { mcpServers: './.mcp.json' } : {}) };
      await mkdir(path.join(out, '.plugin'), { recursive: true });
      await writeFile(path.join(out, '.plugin', 'plugin.json'), json(manifest));
      report.push({ target: 'copilot', label: 'Copilot CLI', file: '.plugin/plugin.json', carried: carried(['commands', 'skills', 'servers']), translated, dropped: [...(hasHooks ? ['hooks (Copilot hooks read a different protocol)'] : []), ...(counts.options ? ['options'] : []), ...extra] });
    }
    return { dir: out, from: src.from, name: m.name, report };
  } finally {
    await src.cleanup();
  }
}

export function formatExportReport(result) {
  const lines = ['Exported ' + result.name + ' (' + result.from + ') to ' + result.dir];
  for (const r of result.report) {
    lines.push('  ' + r.label.padEnd(20) + r.file);
    if (r.carried.length) lines.push('      runs as is: ' + r.carried.join(', '));
    if (r.translated.length) lines.push('      translated: ' + r.translated.join(', '));
    if (r.dropped.length) lines.push('      left out:   ' + r.dropped.join(', '));
  }
  return lines.join('\n') + '\n';
}

/** oasis plugin export [SOURCE] [--to claude,codex,gemini,cursor,copilot|all] --out DIR [--force] */
export async function exportCli(root, params, write) {
  const take = (flag) => { const i = params.indexOf(flag); if (i < 0) return null; const value = params[i + 1]; params.splice(i, 2); return value; };
  const to = take('--to');
  const outDir = take('--out') || take('-o');
  const force = params.includes('--force');
  const rest = params.filter((p) => p !== '--force');
  const source = path.resolve(root, rest[0] || '.');
  const targets = !to || to === 'all' ? EXPORT_TARGETS : to.split(',').map((t) => t.trim()).filter(Boolean);
  const out = outDir ? path.resolve(root, outDir) : path.join(path.dirname(source), path.basename(source) + '-universal');
  write(formatExportReport(await exportPlugin(source, { out, targets, force })));
}
