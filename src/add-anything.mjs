// One way in for every kind of add-on. `oasis add <anything>`, `/add <anything>`
// and the agent's add_extension tool all land here: paste a GitHub link,
// owner/repo, plugin@marketplace, an MCP server URL, an npm package or a
// registry name, and OASIS works out what it is, shows one summary, and
// installs and configures it with the existing installers:
//
//   Claude Code marketplace   -> addMarketplace (+ the plugin you named)
//   Claude Code plugin repo   -> a one-plugin local marketplace + installPlugin
//   Native OASIS package      -> installNativePlugin with the permissions it asks for
//   Agent Skills (SKILL.md)   -> installSkillsFromSource
//   MCP server (repo/package) -> the MCP Registry entry, or npx for an npm package
//   Remote MCP URL            -> addRemoteMcpServer (http, or sse for /sse URLs)
//   Markdown agents/commands  -> installGitHubExtension (prompts only)
//
// Nothing is changed before the one approval. Nothing from the source runs
// during inspection: the repository is cloned shallowly with hooks off and
// read as files.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const GIT_HOSTS = /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.sr\.ht|huggingface\.co)$/i;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const slug = (value, fallback = 'addon') => String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || fallback;

// What did the user give us? Pure string work; no network.
export function classifySource(raw) {
  const text = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!text) throw new Error('Tell OASIS what to add: a GitHub link, owner/repo, plugin@marketplace, an MCP server URL or an npm package.');
  if (text.length > 800) throw new Error('That source is too long.');
  const [base, fragment = ''] = text.split('#');
  if (/^(\.{1,2}[\\/]|\/|~[\\/]|[A-Za-z]:\\)/.test(base)) return { kind: 'repo', local: base.replace(/^~(?=[\\/])/, os.homedir()), pick: fragment, display: text };
  if (/^(git@|ssh:\/\/)/.test(base)) return { kind: 'repo', url: base, ref: fragment, display: text };
  if (/^https?:\/\//i.test(base)) {
    let url;
    try { url = new URL(base); } catch { throw new Error('That link is not a valid URL.'); }
    if (url.username || url.password) throw new Error('Remove the credentials from the link; OASIS will not store them.');
    if (GIT_HOSTS.test(url.hostname) || /\.git$/i.test(url.pathname)) {
      const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
      if (parts.length < 2) throw new Error('Link to a repository (owner/name), not a profile page.');
      // github.com/o/r/tree/REF/sub/dir and /blob/REF/sub/dir/SKILL.md
      // #v1.2.0 or #release/2 is a git ref; #name picks a plugin or skill.
      const fragmentIsRef = /^v?\d|\//.test(fragment);
      let ref = fragmentIsRef ? fragment : '';
      let subdir = '';
      if (['tree', 'blob'].includes(parts[2]) && parts[3]) {
        ref = parts[3];
        subdir = parts.slice(4).join('/');
        if (parts[2] === 'blob') subdir = path.posix.dirname(subdir) === '.' ? '' : path.posix.dirname(subdir);
      }
      return { kind: 'repo', url: url.origin + '/' + parts[0] + '/' + parts[1] + '.git', owner: parts[0], name: parts[1], ref, subdir, pick: fragmentIsRef ? '' : fragment, display: text };
    }
    if (/\.zip$/i.test(url.pathname)) return { kind: 'zip', url: url.href, display: text };
    return { kind: 'remote-mcp', url: url.href, transport: /\/sse\/?$/i.test(url.pathname) ? 'sse' : 'http', name: slug(url.hostname.replace(/^(www|mcp|api)\./, '').split('.')[0], 'remote'), display: text };
  }
  if (/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/i.test(text)) return { kind: 'plugin-spec', spec: text.toLowerCase(), display: text };
  if (/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(@[\w.^~-]+)?$/i.test(text)) return { kind: 'npm-mcp', pkg: text, display: text };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\/[a-z0-9._-]+$/i.test(text)) return { kind: 'registry', registryName: text, display: text };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(base)) {
    const fragmentIsRef = /^v?\d|\//.test(fragment);
    return { kind: 'repo', url: 'https://github.com/' + base + '.git', owner: base.split('/')[0], name: base.split('/')[1], ref: fragmentIsRef ? fragment : '', subdir: '', pick: fragmentIsRef ? '' : fragment, display: text };
  }
  if (/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(text)) return { kind: 'search', query: text, display: text };
  throw new Error('OASIS could not tell what "' + text + '" is. Paste a GitHub link, owner/repo, plugin@marketplace, an MCP server URL or an npm package.');
}

function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: options.cwd, timeout: options.timeout || 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', ...(options.env || {}) }
    }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim().split('\n').slice(-2).join(' ') || 'git failed')) : resolve(String(stdout)));
  });
}

async function fetchRepository(source, options = {}) {
  if (source.local) {
    const dir = path.resolve(options.root || process.cwd(), source.local);
    const info = await stat(dir).catch(() => null);
    if (!info || !info.isDirectory()) throw new Error('No folder at ' + source.local + '.');
    return { dir, cleanup: async () => {} };
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), 'oasis-add-'));
  const clone = path.join(temp, 'repo');
  try {
    const cloneImpl = options.cloneImpl || (async (url, dest, ref) => {
      await runGit(['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=user', 'clone', '--depth', '1', '--quiet', ...(ref ? ['--branch', ref] : []), '--', url, dest]);
    });
    await cloneImpl(source.url, clone, source.ref || '');
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw new Error('Could not download ' + source.display + ': ' + error.message + (/not found|could not read|Authentication/i.test(error.message) ? ' (is it public and spelled right?)' : ''));
  }
  const dir = source.subdir ? path.join(clone, source.subdir) : clone;
  if (path.relative(clone, dir).startsWith('..')) { await rm(temp, { recursive: true, force: true }); throw new Error('That path leaves the repository.'); }
  return { dir, cleanup: () => rm(temp, { recursive: true, force: true }) };
}

const readJsonFile = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const exists = async (file) => Boolean(await stat(file).catch(() => null));

async function findFiles(dir, test, { depth = 4, limit = 200 } = {}) {
  const out = [];
  async function walk(current, level) {
    if (level > depth || out.length >= limit) return;
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, level + 1);
      else if (entry.isFile() && test(path.relative(dir, full).replace(/\\/g, '/'))) out.push(path.relative(dir, full).replace(/\\/g, '/'));
      if (out.length >= limit) return;
    }
  }
  await walk(dir, 0);
  return out;
}

// Skills under a hidden top-level folder (.claude/skills, .github/skills, …)
// are usually for the repository's own maintainers; they count only when the
// repository has no other skills and nothing else to install.
async function skillNames(dir, { includeHidden = false } = {}) {
  const skills = (await findFiles(dir, (rel) => /(^|\/)SKILL\.md$/i.test(rel), { depth: 5 })).filter((rel) => includeHidden || !rel.startsWith('.'));
  const names = [];
  for (const rel of skills.slice(0, 80)) {
    const text = await readFile(path.join(dir, rel), 'utf8').catch(() => '');
    const match = /^name:\s*["']?([A-Za-z0-9-]{1,64})/m.exec(text);
    names.push(match ? match[1] : path.posix.basename(path.posix.dirname(rel)) || 'skill');
  }
  return [...new Set(names)];
}

// What is in this folder? Reads files only.
export async function inspectAddonDirectory(dir) {
  const marketplace = await readJsonFile(path.join(dir, '.claude-plugin', 'marketplace.json'));
  if (marketplace && Array.isArray(marketplace.plugins)) {
    return { type: 'marketplace', name: String(marketplace.name || ''), plugins: marketplace.plugins.filter((p) => p && p.name).map((p) => ({ name: String(p.name).toLowerCase(), description: String(p.description || '').slice(0, 160) })), skills: await skillNames(dir) };
  }
  const claudePlugin = await readJsonFile(path.join(dir, '.claude-plugin', 'plugin.json'));
  if (claudePlugin && claudePlugin.name) {
    const parts = [];
    for (const [label, test] of [['commands', /^commands\/.+\.md$/], ['agents', /^agents\/.+\.md$/], ['skills', /^skills\/[^/]+\/SKILL\.md$/i]]) {
      const found = await findFiles(dir, (rel) => test.test(rel), { depth: 3 });
      if (found.length) parts.push(found.length + ' ' + label);
    }
    if (await exists(path.join(dir, 'hooks', 'hooks.json')) || claudePlugin.hooks) parts.push('hooks (they run commands on events)');
    if (await exists(path.join(dir, '.mcp.json')) || claudePlugin.mcpServers) parts.push('MCP servers (they run when sessions start)');
    return { type: 'claude-plugin', name: String(claudePlugin.name).toLowerCase(), description: String(claudePlugin.description || '').slice(0, 200), contents: parts };
  }
  const native = await readJsonFile(path.join(dir, 'plugin.json'));
  if (native && native.schemaVersion === 1 && native.name) {
    return { type: 'native-plugin', name: String(native.name), description: String(native.description || '').slice(0, 200), permissions: Array.isArray(native.permissions) ? native.permissions.map(String) : [] };
  }
  const serverJson = await readJsonFile(path.join(dir, 'server.json'));
  const pkg = await readJsonFile(path.join(dir, 'package.json'));
  const pyproject = await readFile(path.join(dir, 'pyproject.toml'), 'utf8').catch(() => '');
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) } : {};
  const npmMcp = pkg && (deps['@modelcontextprotocol/sdk'] || deps.fastmcp || /(^|[-/])mcp([-/]|$)|mcp-server|server-/.test(String(pkg.name || '')));
  const pyMcp = /\b(mcp|fastmcp)\b\s*[>=<~\]"',]/.test(pyproject);
  if ((serverJson && serverJson.name) || npmMcp || pyMcp) {
    return {
      type: 'mcp-server',
      registryName: serverJson && typeof serverJson.name === 'string' ? serverJson.name : '',
      npmName: pkg && !pkg.private && typeof pkg.name === 'string' && (pkg.bin || npmMcp) ? pkg.name : '',
      python: pyMcp
    };
  }
  const skills = await skillNames(dir);
  if (skills.length) return { type: 'skills', skills };
  const collection = [];
  for (const rel of await findFiles(dir, (r) => /^(src|packages|servers)\/[^/]+\/package\.json$/.test(r), { depth: 2, limit: 80 })) {
    const sub = await readJsonFile(path.join(dir, rel));
    const subDeps = sub ? { ...(sub.dependencies || {}), ...(sub.devDependencies || {}) } : {};
    if (sub && !sub.private && sub.name && (subDeps['@modelcontextprotocol/sdk'] || /mcp|server-/.test(sub.name))) collection.push({ name: path.posix.basename(path.posix.dirname(rel)), npmName: sub.name });
  }
  for (const rel of await findFiles(dir, (r) => /^(src|packages|servers)\/[^/]+\/pyproject\.toml$/.test(r), { depth: 2, limit: 80 })) {
    const text = await readFile(path.join(dir, rel), 'utf8').catch(() => '');
    const pyName = /^name\s*=\s*"([^"]+)"/m.exec(text);
    if (pyName && /\bmcp\b/.test(text)) collection.push({ name: path.posix.basename(path.posix.dirname(rel)), pypiName: pyName[1] });
  }
  if (collection.length) return { type: 'mcp-collection', servers: collection };
  const prompts = await findFiles(dir, (rel) => /^(\.claude\/)?(agents|commands)\/.+\.md$/i.test(rel), { depth: 3 });
  if (prompts.length) return { type: 'prompts', count: prompts.length };
  const hidden = await skillNames(dir, { includeHidden: true });
  if (hidden.length) return { type: 'skills', skills: hidden };
  if (await exists(path.join(dir, 'gemini-extension.json'))) return { type: 'unsupported', reason: 'a Gemini CLI extension; OASIS can import its skills or prompts when it has them, but this one has neither' };
  return { type: 'unsupported', reason: 'no plugin, marketplace, skills, MCP server or agent prompts' };
}

function chooseFromMarketplace(info, source) {
  const want = String(source.pick || '').toLowerCase();
  if (want) return info.plugins.find((p) => p.name === want) ? [want] : null;
  if (info.plugins.length === 1) return [info.plugins[0].name];
  const repoName = String(source.name || '').toLowerCase();
  const match = info.plugins.find((p) => p.name === repoName);
  return match ? [match.name] : [];
}

// Build the plan: what will happen, one summary for the approval, and a run().
export async function planAddon(raw, options = {}) {
  const env = options.env || process.env;
  const root = options.root || process.cwd();
  const scope = options.scope === 'project' ? 'project' : 'user';
  const source = classifySource(raw);
  const plugins = () => import('./claude-plugins.mjs');

  if (source.kind === 'plugin-spec') {
    return { kind: 'claude-plugin', title: 'Claude Code plugin ' + source.spec, summary: 'Install and enable the plugin ' + source.spec + ' from an added marketplace. Its commands, agents and skills load in new sessions; its hooks and MCP servers run as the plugin defines them.',
      run: async () => { const { installPlugin } = await plugins(); const done = await installPlugin(source.spec, { env, root, scope }); return { installed: [done.id], message: 'Installed and enabled ' + done.id + '.', reload: true }; } };
  }
  if (source.kind === 'remote-mcp') {
    const name = slug(options.name || source.name, 'remote');
    return { kind: 'remote-mcp', title: 'Remote MCP server ' + name, summary: 'Add the remote MCP server "' + name + '" (' + source.transport + '): ' + source.url + '. No local code runs; each of its tools asks before it acts unless you allow it.',
      run: async () => { const { addRemoteMcpServer } = await import('./mcp-remote-add.mjs'); const message = await addRemoteMcpServer(['--transport', source.transport, '--scope', scope, name, source.url], { root, env, approve: async () => true }); return { installed: [name], message, reload: true }; } };
  }
  if (source.kind === 'zip') {
    return { kind: 'zip', title: 'Plugin archive', summary: 'Plugin .zip links load for one session: run oasis --plugin-url ' + source.url + '.', run: async () => ({ installed: [], message: 'Start OASIS with --plugin-url ' + source.url + ' to load this plugin for that session. For a permanent install, link its GitHub repository instead.' }) };
  }
  if (source.kind === 'registry' || source.kind === 'search') {
    const registry = await import('./mcp-registry.mjs');
    let registryName = source.registryName;
    if (!registryName) {
      const rows = await registry.searchRegistry(source.query, { env, fetchImpl: options.fetchImpl, limit: 10 }).catch(() => []);
      const q = source.query.toLowerCase();
      // searchRegistry already ranks the vendor's own server first.
      const best = rows.find((row) => String(row.name || '').toLowerCase().includes(q) || String(row.title || '').toLowerCase().includes(q));
      if (!best) return { kind: 'none', title: 'Nothing found', summary: '', run: async () => ({ installed: [], message: 'No MCP server called "' + source.query + '" in the MCP Registry. Paste its GitHub link or npm package instead.' }) };
      registryName = best.name;
    }
    const localName = slug(options.name || registry.defaultLocalName(registryName), 'mcp');
    return { kind: 'mcp-registry', title: 'MCP server ' + registryName, summary: 'Add the MCP server ' + registryName + ' from the official MCP Registry as "' + localName + '". It downloads and runs that server when sessions start.',
      run: async () => { const message = await registry.installFromRegistry([registryName, '--name', localName, '--scope', scope], { root, env, approve: async () => true, fetchImpl: options.fetchImpl }); return { installed: [localName], message, reload: true }; } };
  }
  if (source.kind === 'npm-mcp' && !options.skipRegistry) {
    const registryName = await findRegistryEntry({ npm: source.pkg }, { env, fetchImpl: options.fetchImpl });
    if (registryName) return planAddon(registryName, { ...options, name: options.name || slug(source.pkg.replace(/^@[^/]+\//, '').replace(/@[^@]*$/, '').replace(/^(mcp-)?server-|-mcp(-server)?$/g, ''), 'mcp') });
  }
  if (source.kind === 'npm-mcp') {
    const name = slug(options.name || source.pkg.replace(/^@[^/]+\//, '').replace(/@[^@]*$/, '').replace(/^(mcp-)?server-|-mcp(-server)?$/g, ''), 'mcp');
    return { kind: 'npm-mcp', title: 'MCP server ' + source.pkg, summary: 'Add the MCP server "' + name + '": runs npx -y ' + source.pkg + ' when sessions start (it downloads that npm package).',
      run: async () => ({ ...(await writeStdioServer(name, { command: 'npx', args: ['-y', source.pkg] }, { root, env, scope })), reload: true }) };
  }

  // A repository or folder: look inside.
  const fetched = await fetchRepository(source, { root, cloneImpl: options.cloneImpl });
  let info;
  try { info = await inspectAddonDirectory(fetched.dir); } catch (error) { await fetched.cleanup(); throw error; }
  const repoLabel = source.owner ? source.owner + '/' + source.name : source.display;
  const done = async (fn) => { try { return await fn(); } finally { await fetched.cleanup(); } };
  const base = { source: repoLabel, detected: info, cleanup: fetched.cleanup };

  if (info.type === 'marketplace' && source.pick && !info.plugins.some((p) => p.name === source.pick.toLowerCase()) && info.skills.some((name) => name.toLowerCase() === source.pick.toLowerCase())) {
    info = { type: 'skills', skills: info.skills };
  }
  if (info.type === 'marketplace') {
    const picks = chooseFromMarketplace(info, source);
    if (picks === null) { await fetched.cleanup(); throw new Error('The marketplace ' + info.name + ' has no plugin or skill called ' + source.pick + '. Plugins: ' + info.plugins.map((p) => p.name).join(', ') + '.'); }
    const list = info.plugins.slice(0, 30).map((p) => p.name).join(', ');
    return { ...base, kind: 'marketplace', title: 'Plugin marketplace ' + info.name,
      summary: 'Add the plugin marketplace "' + info.name + '" (' + info.plugins.length + (info.plugins.length === 1 ? ' plugin)' : ' plugins)') + (picks.length ? ' and install ' + picks.join(', ') + '.' : '. Then name a plugin to install, e.g. ' + (info.plugins[0] ? info.plugins[0].name + '@' + info.name : 'NAME@' + info.name) + '.'),
      run: () => done(async () => {
        const { addMarketplace, installPlugin } = await plugins();
        const market = await addMarketplace(source.local ? fetched.dir : source.url.replace(/\.git$/, '') + '.git' + (source.ref ? '#' + source.ref : ''), { env, cwd: root });
        const installed = [];
        for (const name of picks) installed.push((await installPlugin(name + '@' + market.name, { env, root, scope })).id);
        return { installed, available: info.plugins.map((p) => p.name), message: 'Added marketplace ' + market.name + '.' + (installed.length ? ' Installed and enabled ' + installed.join(', ') + '.' : ' Available: ' + list + (info.plugins.length > 30 ? ', …' : '') + '. Say "add NAME@' + market.name + '" to install one.'), reload: installed.length > 0 };
      }) };
  }
  if (info.type === 'claude-plugin') {
    return { ...base, kind: 'claude-plugin', title: 'Claude Code plugin ' + info.name,
      summary: 'Install and enable the Claude Code plugin "' + info.name + '" from ' + repoLabel + (info.contents.length ? ': ' + info.contents.join(', ') : '') + '.',
      run: () => done(async () => {
        const { addMarketplace, installPlugin } = await plugins();
        // A plugin repository without a marketplace: wrap it in a one-plugin marketplace.
        const market = slug('repo-' + (source.owner ? source.owner + '-' + source.name : info.name));
        const marketDir = path.join(getConfigDirectory(env), 'plugins', 'single', market);
        await mkdir(path.join(marketDir, '.claude-plugin'), { recursive: true });
        const pluginSource = source.local
          ? './plugin'
          : (source.subdir ? { source: 'git-subdir', url: source.url, path: source.subdir, ...(source.ref ? { ref: source.ref } : {}) } : { source: 'url', url: source.url, ...(source.ref ? { ref: source.ref } : {}) });
        if (source.local) {
          const { cp } = await import('node:fs/promises');
          await rm(path.join(marketDir, 'plugin'), { recursive: true, force: true });
          await cp(fetched.dir, path.join(marketDir, 'plugin'), { recursive: true, filter: (file) => !file.split(path.sep).includes('.git') });
        }
        await writeFile(path.join(marketDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: market, owner: { name: source.owner || 'local' }, plugins: [{ name: info.name, source: pluginSource }] }, null, 2) + '\n');
        await addMarketplace(marketDir, { env, cwd: root });
        const result = await installPlugin(info.name + '@' + market, { env, root, scope });
        return { installed: [result.id], message: 'Installed and enabled ' + result.id + '.', reload: true };
      }) };
  }
  if (info.type === 'native-plugin') {
    return { ...base, kind: 'native-plugin', title: 'OASIS plugin ' + info.name,
      summary: 'Install the OASIS plugin "' + info.name + '" from ' + repoLabel + ' with the permissions it asks for: ' + (info.permissions.join(', ') || 'none') + '.',
      run: () => done(async () => {
        const { installNativePlugin } = await import('./native-plugins.mjs');
        const result = await installNativePlugin(source.local ? fetched.dir : source.url + (source.ref ? '#' + source.ref : ''), { env, root, grantedPermissions: info.permissions, acceptPermissionDiff: true });
        return { installed: [info.name], message: 'Installed ' + info.name + '.' + (result && result.message ? ' ' + result.message : ''), reload: true };
      }) };
  }
  if (info.type === 'skills') {
    const want = String(source.pick || '').trim();
    const chosen = want ? info.skills.filter((s) => s.toLowerCase() === want.toLowerCase()) : info.skills;
    if (want && !chosen.length) { await fetched.cleanup(); throw new Error('No skill called ' + want + ' in ' + repoLabel + '. It has: ' + info.skills.join(', ') + '.'); }
    const { getUniversalGlobalSkillsDirectory } = await import('./tools.mjs');
    const targetDir = scope === 'project' ? path.join(root, '.agents', 'skills') : getUniversalGlobalSkillsDirectory(env);
    return { ...base, kind: 'skills', title: chosen.length === 1 ? 'Skill ' + chosen[0] : chosen.length + ' skills',
      summary: 'Install ' + (chosen.length === 1 ? 'the skill ' + chosen[0] : chosen.length + ' skills (' + chosen.slice(0, 12).join(', ') + (chosen.length > 12 ? ', …' : '') + ')') + ' from ' + repoLabel + ' into ' + targetDir + '. Only the instruction files are copied; nothing runs.',
      run: () => done(async () => {
        const { installSkillsFromSource } = await import('./skill-install.mjs');
        const result = await installSkillsFromSource(fetched.dir, { all: !want, skill: want || undefined, targetDir, env });
        return { installed: result.installed.map((s) => s.name), message: result.message, reload: true };
      }) };
  }
  if (info.type === 'mcp-server') {
    if (info.registryName) {
      await fetched.cleanup();
      return planAddon(info.registryName, { ...options, name: options.name || slug(source.name || '', '') || undefined });
    }
    if (!source.local) {
      const registryName = await findRegistryEntry({ npm: info.npmName, repoUrl: source.url, query: source.name }, { env, fetchImpl: options.fetchImpl });
      if (registryName) { await fetched.cleanup(); return planAddon(registryName, { ...options, name: options.name || slug(source.name, 'mcp') }); }
    }
    if (info.npmName) {
      await fetched.cleanup();
      return npmPlan(info.npmName, source, { root, env, scope, name: options.name });
    }
    if (info.python && !source.local) {
      await fetched.cleanup();
      const name = slug(options.name || source.name, 'mcp');
      const spec = 'git+' + source.url.replace(/\.git$/, '') + (source.ref ? '@' + source.ref : '');
      return { kind: 'python-mcp', title: 'MCP server ' + repoLabel, summary: 'Add the Python MCP server "' + name + '": runs uvx --from ' + spec + ' ' + name + ' when sessions start (needs uv).',
        run: async () => ({ ...(await writeStdioServer(name, { command: 'uvx', args: ['--from', spec, source.name] }, { root, env, scope })), reload: true }) };
    }
    await fetched.cleanup();
    return { kind: 'none', title: 'MCP server source', summary: '', run: async () => ({ installed: [], message: repoLabel + ' looks like an MCP server, but it is not published to npm or the MCP Registry. Follow its README to build it, then add it with oasis mcp add NAME -- COMMAND ARGS.' }) };
  }
  if (info.type === 'mcp-collection') {
    await fetched.cleanup();
    const want = String(source.pick || '').toLowerCase();
    const hit = want && info.servers.find((server) => server.name.toLowerCase() === want);
    if (hit && hit.npmName) return planAddon(hit.npmName, { ...options, name: options.name || slug(hit.name, 'mcp') });
    if (hit && hit.pypiName) {
      const name = slug(options.name || hit.name, 'mcp');
      return { kind: 'python-mcp', title: 'MCP server ' + hit.pypiName, summary: 'Add the MCP server "' + name + '": runs uvx ' + hit.pypiName + ' when sessions start (needs uv).',
        run: async () => ({ ...(await writeStdioServer(name, { command: 'uvx', args: [hit.pypiName] }, { root, env, scope })), reload: true }) };
    }
    const names = info.servers.map((server) => server.name);
    return { kind: 'none', title: 'MCP servers', summary: '', run: async () => ({ installed: [], available: names, message: repoLabel + ' has ' + names.length + ' MCP servers: ' + names.join(', ') + '. Add one with "' + repoLabel + '#' + names[0] + '".' }) };
  }
  if (info.type === 'prompts' && source.owner && /github\.com/.test(source.url)) {
    await fetched.cleanup();
    return { kind: 'prompts', title: info.count + ' agent prompts', source: repoLabel,
      summary: 'Import ' + info.count + ' Markdown agent and command prompts from ' + repoLabel + '. Only the Markdown is copied; nothing runs.',
      run: async () => {
        const { installGitHubExtension } = await import('./extensions.mjs');
        const result = await installGitHubExtension('https://github.com/' + repoLabel, { env, root, scope: scope === 'project' ? 'project' : 'self' });
        return { installed: [repoLabel], message: (result && result.message) || 'Imported prompts from ' + repoLabel + '.', reload: true };
      } };
  }
  await fetched.cleanup();
  return { kind: 'none', title: 'Nothing to install', summary: '', run: async () => ({ installed: [], message: repoLabel + ' has ' + info.reason + '.' }) };
}

// The MCP Registry knows which arguments and keys a server needs, so prefer
// its entry for an npm package or a repository when there is one.
export async function findRegistryEntry({ npm = '', repoUrl = '', query = '' }, { env = process.env, fetchImpl } = {}) {
  const registry = await import('./mcp-registry.mjs');
  const q = query || String(npm).replace(/^@[^/]+\//, '').replace(/@[^@]*$/, '');
  const rows = await registry.searchRegistry(q, { env, fetchImpl, limit: 8 }).catch(() => []);
  const want = String(repoUrl).toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
  if (want) {
    const hit = rows.find((row) => String(row.repository || '').toLowerCase().replace(/\.git$/, '').replace(/\/$/, '') === want);
    if (hit) return hit.name;
  }
  if (npm) {
    const bare = String(npm).replace(/@[^@/]*$/, '') || npm;
    for (const row of rows.slice(0, 5)) {
      const server = await registry.getRegistryServer(row.name, { env, fetchImpl }).catch(() => null);
      if (server && Array.isArray(server.packages) && server.packages.some((p) => p && p.identifier === bare)) return row.name;
    }
  }
  return '';
}

function npmPlan(pkg, source, { root, env, scope, name }) {
  const local = slug(name || String(pkg).replace(/^@[^/]+\//, '').replace(/^(mcp-)?server-|-mcp(-server)?$/g, ''), 'mcp');
  return { kind: 'npm-mcp', title: 'MCP server ' + pkg, summary: 'Add the MCP server "' + local + '": runs npx -y ' + pkg + ' when sessions start (it downloads that npm package).',
    run: async () => ({ ...(await writeStdioServer(local, { command: 'npx', args: ['-y', pkg] }, { root, env, scope })), reload: true }) };
}

async function writeStdioServer(name, entry, { root, env, scope }) {
  if (!NAME.test(name)) throw new Error('Invalid server name: ' + name);
  const { parseMcpServerEntries } = await import('./mcp-project.mjs');
  const check = parseMcpServerEntries({ mcpServers: { [name]: entry } }, env, scope);
  if (check.failures && check.failures.length) throw new Error('MCP server "' + name + '" is not usable: ' + check.failures[0].error);
  const file = scope === 'project' ? path.join(root, '.mcp.json') : path.join(getConfigDirectory(env), 'mcp.json');
  const parsed = (await readJsonFile(file)) || {};
  const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers) ? parsed.mcpServers : {};
  await mkdir(path.dirname(file), { recursive: true, ...(scope === 'user' ? { mode: 0o700 } : {}) });
  await writeFile(file, JSON.stringify({ ...parsed, mcpServers: { ...servers, [name]: entry } }, null, 2) + '\n', scope === 'user' ? { mode: 0o600 } : {});
  return { installed: [name], message: 'Added MCP server "' + name + '" (' + [entry.command, ...entry.args].join(' ') + ') in ' + file + '. It starts with your next session.' };
}

// Plan, ask once, install. approve(summary) -> boolean.
export async function addAnything(raw, options = {}) {
  const plan = await planAddon(raw, options);
  if (plan.kind === 'none' || plan.kind === 'zip') return { ...(await plan.run()), kind: plan.kind, approved: true };
  const approve = options.approve || (async () => false);
  if (!(await approve(plan.summary, plan))) {
    if (plan.cleanup) await plan.cleanup().catch(() => {});
    return { kind: plan.kind, approved: false, installed: [], message: 'Nothing was installed.' };
  }
  const result = await plan.run();
  return { kind: plan.kind, approved: true, title: plan.title, ...result };
}
