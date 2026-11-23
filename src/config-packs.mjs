// Formats that are not plugins in their own tool, but are shared like plugins:
//
//   MCP Bundle       manifest.json with manifest_version (or dxt_version) and a
//                    server: Claude Desktop extensions (.mcpb, formerly .dxt).
//                    The server starts as a plugin MCP server, user_config
//                    becomes plugin options, prompts become commands.
//   Config pack      a repository of another agent's customizations:
//                    VS Code / GitHub Copilot (.github/prompts/*.prompt.md,
//                    .github/agents/*.agent.md, .github/chatmodes, instructions,
//                    copilot-instructions.md, .vscode/mcp.json, and the same
//                    folders at the top level as awesome-copilot keeps them),
//                    Continue (.continue/rules, prompts, mcpServers blocks), and
//                    the project files `oasis import` reads for Cursor, Windsurf,
//                    Cline, OpenCode, Antigravity and Gemini CLI.
//
// Both are turned into a Claude Code plugin folder, like plugin-convert.mjs does
// for other plugin formats, so `oasis add` installs them the same way.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseYamlMapping, splitFrontMatter } from './frontmatter.mjs';

const slug = (value, fallback = 'item') => String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || fallback;
const readJson = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const readText = (file) => readFile(file, 'utf8').catch(() => '');
const isDir = async (dir) => Boolean(await stat(dir).then((s) => s.isDirectory()).catch(() => false));

function front(text) {
  const { metadata, body, hasFrontMatter } = splitFrontMatter(String(text).replace(/\r\n/g, '\n'));
  let meta = {};
  if (hasFrontMatter) { try { meta = parseYamlMapping(metadata, { schema: 'core' }) || {}; } catch { meta = {}; } }
  return { meta, body: String(body || '').trim() };
}

async function listMd(dir, suffix) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(suffix)).map((e) => ({ file: path.join(dir, e.name), base: e.name.slice(0, -suffix.length) })).sort((a, b) => a.base.localeCompare(b.base));
}

// ---------- MCP Bundles ----------

/** An MCP Bundle manifest (.mcpb / .dxt) in dir, or null. */
export async function detectMcpBundle(dir) {
  const m = await readJson(path.join(dir, 'manifest.json'));
  if (!m || typeof m !== 'object' || !m.name || !(m.manifest_version || m.dxt_version) || !m.server || typeof m.server !== 'object') return null;
  return { format: 'mcp-bundle', label: 'MCP Bundle', name: slug(m.name, 'bundle'), description: String(m.description || m.display_name || ''), version: String(m.version || ''), manifest: m };
}

// Bundle variables: ${__dirname} is the bundle folder; the folder names are
// resolved for this machine, as Claude Desktop does when it starts the server.
function bundleValue(value) {
  if (typeof value !== 'string') return value;
  const home = os.homedir();
  return value
    .replace(/\$\{__dirname\}/g, '${CLAUDE_PLUGIN_ROOT}')
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$\{DESKTOP\}/g, path.join(home, 'Desktop'))
    .replace(/\$\{DOCUMENTS\}/g, path.join(home, 'Documents'))
    .replace(/\$\{DOWNLOADS\}/g, path.join(home, 'Downloads'))
    .replace(/\$\{(?:pathSeparator|\/)\}/g, path.sep);
}

function bundleServer(m, platform = process.platform) {
  const server = m.server || {};
  let config = server.mcp_config && typeof server.mcp_config === 'object' ? { ...server.mcp_config } : null;
  if (config && config.platform_overrides && typeof config.platform_overrides === 'object' && config.platform_overrides[platform]) config = { ...config, ...config.platform_overrides[platform] };
  if (config) delete config.platform_overrides;
  // No mcp_config: run the entry point with the runtime the type names.
  if (!config || typeof config.command !== 'string') {
    const entry = typeof server.entry_point === 'string' ? '${__dirname}/' + server.entry_point.replace(/^\.\//, '') : '';
    if (!entry) return null;
    config = server.type === 'node' ? { command: 'node', args: [entry] } : server.type === 'python' ? { command: 'python3', args: [entry] } : server.type === 'uv' ? { command: 'uv', args: ['run', '--directory', '${__dirname}', entry] } : { command: entry };
  }
  const out = { command: bundleValue(config.command) };
  if (Array.isArray(config.args)) out.args = config.args.map((a) => bundleValue(String(a)));
  if (config.env && typeof config.env === 'object') out.env = Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, bundleValue(String(v))]));
  out.cwd = '${CLAUDE_PLUGIN_ROOT}';
  return out;
}

function bundleUserConfig(m) {
  const raw = m.user_config && typeof m.user_config === 'object' ? m.user_config : {};
  const out = {};
  for (const [key, option] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !option || typeof option !== 'object') continue;
    const type = ['number', 'boolean'].includes(option.type) ? option.type : 'string';
    out[key] = {
      type, title: String(option.title || key),
      ...(option.description ? { description: String(option.description) } : {}),
      ...(option.sensitive ? { sensitive: true } : {}),
      ...(option.required ? { required: true } : {}),
      ...(option.default !== undefined ? { default: Array.isArray(option.default) ? option.default.map(bundleValue).join(',') : bundleValue(option.default) } : {})
    };
  }
  return out;
}

function promptToCommand(prompt) {
  if (!prompt || typeof prompt.text !== 'string' || !prompt.name) return null;
  const names = (Array.isArray(prompt.arguments) ? prompt.arguments : []).map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean);
  let body = prompt.text;
  // ${arguments.x} become positional $1, $2… (or $ARGUMENTS for one argument).
  names.forEach((name, index) => { body = body.split('${arguments.' + name + '}').join(names.length === 1 ? '$ARGUMENTS' : '$' + (index + 1)); });
  const hint = names.length > 1 ? 'argument-hint: ' + JSON.stringify(names.map((n) => '<' + n + '>').join(' ')) + '\n' : '';
  return '---\ndescription: ' + JSON.stringify(String(prompt.description || prompt.name)) + '\n' + hint + '---\n\n' + body.trim() + '\n';
}

export async function describeMcpBundle(dir, info) {
  const m = info.manifest;
  const parts = ['an MCP server (' + (m.server.type || 'binary') + ', starts when sessions start)'];
  const options = Object.keys(bundleUserConfig(m));
  if (options.length) parts.push(options.length + ' option' + (options.length === 1 ? '' : 's') + ' (' + options.slice(0, 5).join(', ') + ')');
  const prompts = (Array.isArray(m.prompts) ? m.prompts : []).filter((p) => p && p.text);
  if (prompts.length) parts.push(prompts.length + ' prompt' + (prompts.length === 1 ? '' : 's') + ' (as commands)');
  return parts;
}

export async function bundleUnsupported(dir, info) {
  const m = info.manifest;
  const out = [];
  if (m.server.type === 'node' && !(await isDir(path.join(dir, 'node_modules'))) && !(await isDir(path.join(dir, 'server', 'node_modules')))) {
    const pkg = await readJson(path.join(dir, 'package.json'));
    if (pkg && pkg.dependencies && Object.keys(pkg.dependencies).length) out.push('the server\'s npm dependencies (a packed .mcpb ships them; for a source folder, run npm install in the installed plugin folder)');
  }
  const platforms = m.compatibility && Array.isArray(m.compatibility.platforms) ? m.compatibility.platforms : null;
  if (platforms && !platforms.includes(process.platform)) out.push('this machine (the bundle supports ' + platforms.join(', ') + ')');
  return out;
}

export async function convertMcpBundle(destDir, info, manifest) {
  const m = info.manifest;
  const server = bundleServer(m);
  if (server) manifest.mcpServers = { [info.name]: server };
  const userConfig = bundleUserConfig(m);
  if (Object.keys(userConfig).length) manifest.userConfig = userConfig;
  for (const prompt of Array.isArray(m.prompts) ? m.prompts : []) {
    const body = promptToCommand(prompt);
    if (!body) continue;
    await mkdir(path.join(destDir, 'commands'), { recursive: true });
    await writeFile(path.join(destDir, 'commands', slug(prompt.name, 'prompt') + '.md'), body);
  }
  if (m.display_name) manifest.description = manifest.description || String(m.display_name);
  if (m.author && typeof m.author === 'object' && m.author.name) manifest.author = { name: String(m.author.name), ...(m.author.email ? { email: String(m.author.email) } : {}) };
  if (m.homepage || m.repository) manifest.homepage = String(m.homepage || (typeof m.repository === 'object' ? m.repository.url : m.repository) || '');
}

// ---------- Config packs ----------

// VS Code prompt files: ${input:name} / ${input:name:placeholder} become
// command arguments. ${selection}, ${file} and the like stay as written.
function vscodePromptToCommand(text) {
  const { meta, body } = front(text);
  const inputs = [];
  for (const match of body.matchAll(/\$\{input:([A-Za-z0-9_-]+)(?::[^}]*)?\}/g)) if (!inputs.includes(match[1])) inputs.push(match[1]);
  const converted = body.replace(/\$\{input:([A-Za-z0-9_-]+)(?::[^}]*)?\}/g, (m, name) => inputs.length === 1 ? '$ARGUMENTS' : '$' + (inputs.indexOf(name) + 1));
  const lines = ['---'];
  if (meta.description) lines.push('description: ' + JSON.stringify(String(meta.description)));
  if (inputs.length > 1) lines.push('argument-hint: ' + JSON.stringify(inputs.map((n) => '<' + n + '>').join(' ')));
  if (typeof meta.model === 'string' && meta.model.trim()) lines.push('model: ' + JSON.stringify(meta.model.trim()));
  lines.push('---', '');
  return (lines.length > 3 ? lines.join('\n') : '') + converted + (inputs.length ? '' : '\n\n$ARGUMENTS') + '\n';
}

function vscodeAgentToMarkdown(text, name, kind) {
  const { meta, body } = front(text);
  const lines = ['---', 'name: ' + name, 'description: ' + JSON.stringify(String(meta.description || 'Imported ' + kind + ' ' + name))];
  if (typeof meta.model === 'string' && meta.model.trim()) lines.push('model: ' + JSON.stringify(meta.model.trim()));
  lines.push('---', '', body, '');
  return lines.join('\n');
}

// .vscode/mcp.json: { servers, inputs }. ${input:id} becomes a plugin option,
// ${workspaceFolder} the project folder, ${env:X} an environment variable.
function vscodeServers(doc) {
  const servers = doc && doc.servers && typeof doc.servers === 'object' ? doc.servers : {};
  const inputs = Array.isArray(doc && doc.inputs) ? doc.inputs : [];
  const userConfig = {};
  for (const input of inputs) {
    if (!input || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(String(input.id || ''))) continue;
    userConfig[String(input.id).replace(/-/g, '_')] = { type: 'string', title: String(input.id), ...(input.description ? { description: String(input.description) } : {}), ...(input.password ? { sensitive: true } : {}), ...(input.default !== undefined ? { default: String(input.default) } : {}) };
  }
  const map = (value) => typeof value === 'string' ? value
    .replace(/\$\{input:([A-Za-z0-9_-]+)\}/g, (m, id) => '${user_config.' + id.replace(/-/g, '_') + '}')
    .replace(/\$\{workspaceFolder\}/g, '${CLAUDE_PROJECT_DIR}')
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')
    .replace(/\$\{userHome\}/g, os.homedir()) : value;
  const out = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') continue;
    const spec = JSON.parse(JSON.stringify(raw), (key, value) => map(value));
    if (spec.type === 'stdio') delete spec.type;
    delete spec.envFile; delete spec.dev; delete spec.sandboxEnabled; delete spec.sandbox;
    if (spec.command || spec.url) out[slug(name, 'server')] = spec;
  }
  return { servers: out, userConfig };
}

// Continue blocks: rules (strings or {name, rule, globs}), prompts
// ({name, description, prompt}) and mcpServers (a list).
function continueBlock(doc) {
  const out = { rules: [], prompts: [], servers: {} };
  if (!doc || typeof doc !== 'object') return out;
  for (const rule of Array.isArray(doc.rules) ? doc.rules : []) {
    if (typeof rule === 'string' && rule.trim()) out.rules.push({ name: 'rule-' + (out.rules.length + 1), text: rule });
    else if (rule && typeof rule.rule === 'string') out.rules.push({ name: rule.name || 'rule-' + (out.rules.length + 1), text: rule.rule, globs: rule.globs, description: rule.description });
  }
  for (const prompt of Array.isArray(doc.prompts) ? doc.prompts : []) if (prompt && prompt.name && typeof prompt.prompt === 'string') out.prompts.push(prompt);
  for (const server of Array.isArray(doc.mcpServers) ? doc.mcpServers : []) {
    if (!server || !server.name) continue;
    const env = (value) => typeof value === 'string' ? value.replace(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, '${$1}').replace(/\$\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, '${$1}') : value;
    const spec = server.url ? { type: server.type === 'sse' ? 'sse' : 'http', url: env(server.url) } : server.command ? { command: env(server.command), ...(Array.isArray(server.args) ? { args: server.args.map((a) => env(String(a))) } : {}) } : null;
    if (!spec) continue;
    if (server.env && typeof server.env === 'object') spec.env = Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, env(String(v))]));
    if (server.cwd) spec.cwd = String(server.cwd);
    out.servers[slug(server.name, 'server')] = spec;
  }
  return out;
}

async function readYamlFile(file) {
  try { return parseYaml(await readFile(file, 'utf8')); } catch { return null; }
}

// Everything a config pack holds, without writing anything.
async function scanPack(dir) {
  const found = { commands: [], agents: [], rules: [], skills: [], servers: {}, userConfig: {}, tools: new Set() };
  // VS Code / GitHub Copilot, under .github/ and (awesome-copilot) at the top level.
  for (const base of [path.join(dir, '.github'), dir]) {
    for (const { file, base: name } of await listMd(path.join(base, 'prompts'), '.prompt.md')) { found.commands.push({ name: slug(name), body: vscodePromptToCommand(await readText(file)) }); found.tools.add('VS Code'); }
    for (const [sub, suffix, kind] of [['agents', '.agent.md', 'custom agent'], ['chatmodes', '.chatmode.md', 'chat mode']]) {
      for (const { file, base: name } of await listMd(path.join(base, sub), suffix)) { found.agents.push({ name: slug(name), body: vscodeAgentToMarkdown(await readText(file), slug(name), kind) }); found.tools.add('VS Code'); }
    }
    for (const { file, base: name } of await listMd(path.join(base, 'instructions'), '.instructions.md')) {
      const { meta, body } = front(await readText(file));
      if (body) { found.rules.push({ name: slug(name), text: body, globs: meta.applyTo, description: meta.description }); found.tools.add('VS Code'); }
    }
  }
  // Claude Code project files that sit next to them come along (a plugin
  // reads top-level agents/ and commands/ itself).
  for (const [sub, key] of [['agents', 'agents'], ['commands', 'commands']]) {
    for (const { file, base: name } of await listMd(path.join(dir, '.claude', sub), '.md')) found[key].push({ name: slug(name), body: await readText(file), native: true });
  }
    const copilotInstructions = await readText(path.join(dir, '.github', 'copilot-instructions.md'));
  if (copilotInstructions.trim()) { found.rules.push({ name: 'copilot-instructions', text: copilotInstructions.trim(), always: true }); found.tools.add('VS Code'); }
  const vscodeMcp = await readJson(path.join(dir, '.vscode', 'mcp.json'));
  if (vscodeMcp) {
    const { servers, userConfig } = vscodeServers(vscodeMcp);
    if (Object.keys(servers).length) { Object.assign(found.servers, servers); Object.assign(found.userConfig, userConfig); found.tools.add('VS Code'); }
  }
  // Continue: .continue/{rules,prompts,mcpServers}/ blocks and a config.yaml.
  const blocks = [];
  for (const sub of ['rules', 'prompts', 'mcpServers']) {
    let entries = [];
    try { entries = await readdir(path.join(dir, '.continue', sub), { withFileTypes: true }); } catch {}
    for (const entry of entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, '.continue', sub, entry.name);
      if (/\.ya?ml$/i.test(entry.name)) blocks.push(await readYamlFile(file));
      else if (sub === 'rules' && /\.md$/i.test(entry.name)) { const { meta, body } = front(await readText(file)); if (body) blocks.push({ rules: [{ name: meta.name || entry.name.replace(/\.md$/i, ''), rule: body, globs: meta.globs, description: meta.description }] }); }
      else if (sub === 'prompts' && /\.(md|prompt)$/i.test(entry.name)) { const { meta, body } = front(await readText(file)); if (body) blocks.push({ prompts: [{ name: meta.name || entry.name.replace(/\.(md|prompt)$/i, ''), description: meta.description, prompt: body }] }); }
    }
  }
  for (const name of ['config.yaml', 'config.yml']) { const doc = await readYamlFile(path.join(dir, '.continue', name)); if (doc) blocks.push(doc); }
  // A Continue hub block repository keeps one block at the top (schema: v1).
  for (const name of ['config.yaml', 'block.yaml']) { const doc = await readYamlFile(path.join(dir, name)); if (doc && doc.schema === 'v1') blocks.push(doc); }
  for (const doc of blocks) {
    const block = continueBlock(doc);
    if (block.rules.length || block.prompts.length || Object.keys(block.servers).length) found.tools.add('Continue');
    for (const rule of block.rules) found.rules.push({ name: slug(rule.name), text: rule.text, globs: rule.globs, description: rule.description });
    for (const prompt of block.prompts) found.commands.push({ name: slug(prompt.name), body: (prompt.description ? '---\ndescription: ' + JSON.stringify(String(prompt.description)) + '\n---\n\n' : '') + prompt.prompt.trim() + (prompt.prompt.includes('$ARGUMENTS') ? '' : '\n\n$ARGUMENTS') + '\n' });
    Object.assign(found.servers, block.servers);
  }
  // Project files `oasis import` reads (Cursor, Windsurf, Cline, OpenCode,
  // Antigravity, Gemini CLI), planned against an empty home so only this
  // folder's files count.
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-pack-home-'));
  try {
    const { planImport } = await import('./importers.mjs');
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_CONFIG_DIR: path.join(home, 'oasis'), PATH: process.env.PATH || '' };
    const plan = await planImport(dir, { env, home, sources: ['gemini', 'cursor', 'opencode', 'antigravity', 'windsurf', 'cline'] });
    const label = { gemini: 'Gemini CLI', cursor: 'Cursor', opencode: 'OpenCode', antigravity: 'Antigravity', windsurf: 'Windsurf', cline: 'Cline' };
    for (const item of plan.items) {
      if (item.action !== 'add') continue;
      const inside = (file) => typeof file === 'string' && !path.relative(dir, file).startsWith('..');
      if (item.kind === 'mcp' && item.scope === 'project' && item.server) { found.servers[slug(item.name, 'server')] = item.server; found.tools.add(label[item.source] || item.source); }
      else if (item.kind === 'command' && inside(item.target) && typeof item.content === 'string') { found.commands.push({ name: slug(path.basename(item.target, '.md')), body: item.content }); found.tools.add(label[item.source] || item.source); }
      else if (item.kind === 'agent' && inside(item.target) && typeof item.content === 'string') { found.agents.push({ name: slug(path.basename(item.target, '.md')), body: item.content }); found.tools.add(label[item.source] || item.source); }
      else if (item.kind === 'rule' && inside(item.target) && typeof item.content === 'string') {
        const { meta, body } = front(item.content);
        if (body) { found.rules.push({ name: slug(path.basename(item.target, '.md')), text: body.replace(/^<!-- imported from [^>]*-->\n?/, ''), globs: meta.paths, description: meta.description }); found.tools.add(label[item.source] || item.source); }
      } else if (item.kind === 'skill' && inside(item.from)) { found.skills.push({ name: item.name, from: item.from }); found.tools.add(label[item.source] || item.source); }
    }
  } catch { /* A pack without import-readable files is still a pack. */ } finally { await rm(home, { recursive: true, force: true }); }
  return found;
}

// Claude Code files alone are not a pack (OASIS reads them as they are).
const packSize = (found) => found.tools.size ? found.commands.length + found.agents.length + found.rules.length + found.skills.length + Object.keys(found.servers).length : 0;

/** A folder of another agent's customizations, or null. */
export async function detectConfigPack(dir) {
  const found = await scanPack(dir);
  if (!packSize(found)) return null;
  const pkg = await readJson(path.join(dir, 'package.json'));
  const name = slug((pkg && pkg.name && String(pkg.name).replace(/^@[^/]+\//, '')) || path.basename(path.resolve(dir)), 'pack');
  const tools = [...found.tools];
  return { format: 'config-pack', label: tools.join(' / ') + ' configuration', name, description: 'Commands, agents, rules and MCP servers from ' + tools.join(', ') + ' configuration files', version: '', manifest: { name }, found };
}

export function describeConfigPack(info) {
  const f = info.found;
  const count = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const parts = [];
  if (f.commands.length) parts.push(count(f.commands.length, 'command'));
  if (f.agents.length) parts.push(count(f.agents.length, 'agent'));
  if (f.rules.length) parts.push(count(f.rules.length, 'rule') + ' (as skills)');
  if (f.skills.length) parts.push(count(f.skills.length, 'skill'));
  const servers = Object.keys(f.servers).length;
  if (servers) parts.push(count(servers, 'MCP server') + ' (they run when sessions start)');
  return parts;
}

export async function convertConfigPack(destDir, info, manifest, writeSkill) {
  const f = info.found;
  const seen = new Set();
  const unique = (name) => { let n = name, i = 2; while (seen.has(n)) n = name + '-' + i++; seen.add(n); return n; };
  for (const command of f.commands) {
    await mkdir(path.join(destDir, 'commands'), { recursive: true });
    await writeFile(path.join(destDir, 'commands', unique('c:' + command.name).slice(2) + '.md'), command.body);
  }
  for (const agent of f.agents) {
    await mkdir(path.join(destDir, 'agents'), { recursive: true });
    await writeFile(path.join(destDir, 'agents', unique('a:' + agent.name).slice(2) + '.md'), agent.body);
  }
  for (const rule of f.rules) {
    const globs = Array.isArray(rule.globs) ? rule.globs.join(', ') : typeof rule.globs === 'string' ? rule.globs : '';
    const scope = globs && globs !== '**' && globs !== '**/*' ? ' Applies to files matching ' + globs + '.' : '';
    const always = rule.always || !scope;
    const description = (rule.description || 'Project rule ' + rule.name + ' from ' + manifest.name) + '.' + scope + (always ? ' Always follow this rule.' : '');
    await writeSkill(destDir, unique('s:' + slug(manifest.name + '-' + rule.name).slice(0, 64)).slice(2), description, rule.text);
  }
  for (const skill of f.skills) {
    const target = path.join(destDir, 'skills', unique('s:' + slug(skill.name)).slice(2));
    await cp(skill.from, target, { recursive: true, dereference: false, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
  }
  if (Object.keys(f.servers).length) manifest.mcpServers = f.servers;
  if (Object.keys(f.userConfig).length) manifest.userConfig = f.userConfig;
}
