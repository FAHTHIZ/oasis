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
// Split a pasted command line the way a POSIX shell would (quotes, escapes).
export function splitCommandLine(text) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (ch === '\\' && i + 1 < text.length) { cur += text[++i]; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; }
    else { cur += ch; has = true; }
  }
  if (quote) throw new Error('That command has an unclosed quote.');
  if (has || cur) out.push(cur);
  return out;
}

const RUNNERS = new Set(['npx', 'uvx', 'bunx', 'pnpx', 'docker', 'pipx', 'pnpm', 'uv', 'node', 'python', 'python3', 'deno', 'bun']);

// Name a stdio server after the package it runs.
function serverNameFor(command, args) {
  const words = args.filter((a) => !a.startsWith('-'));
  let pkg = words[0] || command;
  if (command === 'docker') pkg = words.filter((a) => a !== 'run').pop() || 'docker';
  if (['pipx', 'pnpm', 'uv'].includes(command)) pkg = words[1] || words[0] || command;
  const scopeName = /^@([^/]+)\//.exec(pkg);
  pkg = pkg.replace(/^@[^/]+\//, '').replace(/(.)@[^@/]*$/, '$1').replace(/:[^/]*$/, '').split('/').pop();
  const short = pkg.replace(/^(mcp-)?server-|-mcp(-server)?$|^mcp-/g, '');
  return slug(!short || /^(mcp|server|mcp-server)$/.test(short) ? (scopeName ? scopeName[1] : pkg) : short, 'mcp');
}

// cursor://anysphere.cursor-deeplink/mcp/install?name=N&config=BASE64(JSON),
// https://cursor.com/(en/)install-mcp?name=N&config=BASE64, vscode:mcp/install?JSON,
// https://(insiders.)vscode.dev/redirect/mcp/install?name=N&config=JSON.
function installDeeplink(text) {
  let url;
  try { url = new URL(text); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const where = url.protocol + '//' + host + url.pathname;
  let name = url.searchParams.get('name') || '';
  let config = null;
  const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const decode = (raw) => { try { return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; } };
  if (/^cursor:/i.test(url.protocol) || /(^|\.)cursor\.(com|sh)$/.test(host) && /install-mcp|mcp\/install/.test(url.pathname)) {
    const raw = url.searchParams.get('config') || '';
    config = parse(raw) || parse(decode(raw));
  } else if (/^vscode(-insiders)?:/i.test(url.protocol) && /mcp\/install/.test(where)) {
    config = parse(decodeURIComponent(url.search.slice(1)));
    if (config && config.name) name = config.name;
  } else if (/(^|\.)vscode\.dev$/.test(host) && /\/redirect\/mcp\/install/.test(url.pathname)) {
    config = parse(url.searchParams.get('config') || '');
  } else return null;
  if (!config || typeof config !== 'object') throw new Error('That install link has no readable MCP server config.');
  if (config.mcpServers && typeof config.mcpServers === 'object') { const [first] = Object.entries(config.mcpServers); if (first) { name = name || first[0]; config = first[1]; } }
  if (config.url) return { text: String(config.url), name: name || 'mcp', transport: config.type === 'sse' || /\/sse\/?$/.test(config.url) ? 'sse' : 'http', headers: Object.entries(config.headers || {}).map(([k, v]) => k + ': ' + v) };
  if (!config.command) throw new Error('That install link has neither a command nor a URL.');
  return { stdio: { name: slug(name || serverNameFor(String(config.command), (config.args || []).map(String)), 'mcp'), command: String(config.command), args: Array.isArray(config.args) ? config.args.map(String) : [], env: config.env && typeof config.env === 'object' ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, String(v)])) : {} } };
}

// Turn what people copy out of READMEs into a source: install commands from
// Claude Code, Codex, Gemini CLI and the skills CLI, bare npx/uvx/docker
// commands, and package, directory and raw-file pages.
export function normalizePasted(raw) {
  const text = String(raw || '').trim().replace(/^`+|`+$/g, '').replace(/^\$\s+/, '').trim();
  const gemini = /^gemini\s+extensions?\s+install\s+(.+)$/i.exec(text);
  if (gemini) {
    const words = splitCommandLine(gemini[1]);
    const at = words.findIndex((w) => w === '--ref');
    const ref = at >= 0 ? words[at + 1] || '' : (words.find((w) => w.startsWith('--ref=')) || '').slice(6);
    const target = words.filter((w, i) => !w.startsWith('-') && words[i - 1] !== '--ref')[0] || '';
    return { text: target.replace(/^(github\.com\/)/i, 'https://$1') + (ref && /^v?\d|\//.test(ref) ? '#' + ref : '') };
  }
  const plugin = /^(?:\/plugin|claude\s+plugins?|oasis\s+plugins?|codex\s+plugins?\s+(?=marketplace))\s*(?:marketplace\s+add|install|add|i)\s+(.+)$/i.exec(text);
  if (plugin) return { text: splitCommandLine(plugin[1]).filter((w, i, all) => !w.startsWith('-') && !['-s', '--scope'].includes(all[i - 1]))[0] || '' };
  const skills = /^(?:npx\s+(?:-y\s+)?|bunx\s+|pnpx\s+)?skills(?:@\S+)?\s+(?:add|install|i)\s+(.+)$/i.exec(text);
  if (skills) {
    const words = splitCommandLine(skills[1]);
    let pick = '';
    const rest = [];
    for (let i = 0; i < words.length; i++) {
      if (['--skill', '-s'].includes(words[i])) pick = words[++i] || '';
      else if (!words[i].startsWith('-')) rest.push(words[i]);
    }
    return { text: rest[0] + (pick && !rest[0].includes('#') ? '#' + pick : '') };
  }
  const mcpAdd = /^(?:claude|codex|gemini|oasis|qwen|opencode)\s+mcp\s+add\s+(.+)$/i.exec(text);
  if (mcpAdd) {
    const words = splitCommandLine(mcpAdd[1]);
    const env = {};
    const headers = [];
    let transport = '';
    let i = 0;
    const positional = [];
    for (; i < words.length; i++) {
      const w = words[i];
      if (w === '--') { i++; break; }
      if (['-t', '--transport'].includes(w)) transport = words[++i] || '';
      else if (['-s', '--scope'].includes(w)) i++;
      else if (['-e', '--env'].includes(w)) { const [k, ...v] = String(words[++i] || '').split('='); if (k) env[k] = v.join('='); }
      else if (['-H', '--header'].includes(w)) headers.push(words[++i] || '');
      else if (w.startsWith('--transport=')) transport = w.slice(12);
      else if (w.startsWith('-')) continue;
      else { positional.push(w); if (positional.length === 2 && !/^https?:\/\//i.test(w)) { i++; break; } }
    }
    const name = positional[0];
    const target = positional[1];
    if (!name) throw new Error('That mcp add command has no server name.');
    if (target && /^https?:\/\//i.test(target)) return { text: target, name, transport: transport === 'sse' ? 'sse' : 'http', headers };
    const command = target ? [target, ...words.slice(i)] : words.slice(i);
    if (!command.length) throw new Error('That mcp add command has no command to run.');
    return { stdio: { name: slug(name, 'mcp'), command: command[0], args: command.slice(1), env } };
  }
  const words = /^[a-z]/i.test(text) && /\s/.test(text) ? splitCommandLine(text) : [];
  if (words.length > 1 && RUNNERS.has(words[0].toLowerCase())) {
    const command = words[0];
    return { stdio: { name: serverNameFor(command, words.slice(1)), command, args: words.slice(1), env: {} } };
  }
  // "Add to Cursor" and "Install in VS Code" buttons carry the server config.
  const deeplink = installDeeplink(text);
  if (deeplink) return deeplink;
  const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?(#.*)?$/i.exec(text);
  if (ssh) return { text: 'https://github.com/' + ssh[1] + '/' + ssh[2] + (ssh[3] || '') };
  if (/^https?:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); } catch { return { text }; }
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'raw.githubusercontent.com' && parts.length >= 3) {
      const file = parts.slice(3);
      const dir = file.length && /\.[a-z0-9]+$/i.test(file[file.length - 1]) ? file.slice(0, -1) : file;
      return { text: 'https://github.com/' + parts[0] + '/' + parts[1] + '/tree/' + parts[2] + (dir.length ? '/' + dir.join('/') : '') };
    }
    if (host === 'skills.sh' && parts.length >= 2) return { text: parts[0] + '/' + parts[1] + (parts[2] ? '#' + parts[2] : '') };
    if (host === 'npmjs.com' && parts[0] === 'package' && parts[1]) {
      const pkg = parts[1].startsWith('@') ? parts[1] + '/' + (parts[2] || '') : parts[1];
      return pkg.startsWith('@') ? { text: pkg } : { stdio: { name: serverNameFor('npx', [pkg]), command: 'npx', args: ['-y', pkg], env: {} } };
    }
    if (host === 'pypi.org' && parts[0] === 'project' && parts[1]) return { stdio: { name: serverNameFor('uvx', [parts[1]]), command: 'uvx', args: [parts[1]], env: {} } };
    if (host === 'smithery.ai' && parts[0] === 'server' && parts[1]) {
      const id = parts[1].startsWith('@') ? parts[1] + '/' + (parts[2] || '') : parts[1];
      return { text: id.startsWith('@') ? id : id.split('/').pop() };
    }
    if (host === 'modelcontextprotocol.io' || host === 'registry.modelcontextprotocol.io') {
      const name = url.searchParams.get('q') || url.searchParams.get('name');
      if (name) return { text: name };
    }
  }
  return { text };
}

export function classifySource(raw) {
  const pasted = normalizePasted(raw);
  if (pasted.stdio) {
    const { command, args } = pasted.stdio;
    if (!/^[\w.+-]+$/.test(command)) throw new Error('OASIS could not tell what "' + String(raw).trim() + '" runs.');
    // npx asks "Ok to proceed?" for packages it has not cached; a server has no one to answer.
    const fixed = command === 'npx' && !args.some((a) => a === '-y' || a === '--yes') ? ['-y', ...args] : args;
    return { kind: 'stdio-mcp', ...pasted.stdio, args: fixed, display: String(raw).trim() };
  }
  if (pasted.name) {
    const source = classifySource(pasted.text);
    if (source.kind === 'remote-mcp') return { ...source, name: slug(pasted.name, source.name), transport: pasted.transport || source.transport, headers: pasted.headers || [] };
    return source;
  }
  const text = String(pasted.text || '').trim().replace(/^<|>$/g, '');
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
  const convert = await import('./plugin-convert.mjs');
  const foreign = await convert.detectForeignPlugin(dir);
  if (foreign) return { type: 'foreign-plugin', format: foreign.format, label: foreign.label, name: foreign.name, description: foreign.description.slice(0, 200), contents: await convert.describeForeignPlugin(dir, foreign) };
  const codexMarket = await convert.detectCodexMarketplace(dir);
  if (codexMarket && codexMarket.plugins.length) return { type: 'codex-marketplace', name: codexMarket.name, plugins: codexMarket.plugins.map((p) => ({ name: p.name, description: p.description.slice(0, 160), path: p.path })) };
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

// Convert a Gemini, Codex or Agent Plugins plugin into a one-plugin marketplace and install it.
async function installConverted(dir, foreign, source, { env, root, scope }) {
  const { convertToClaudePlugin } = await import('./plugin-convert.mjs');
  const { addMarketplace, installPlugin } = await import('./claude-plugins.mjs');
  const market = slug('repo-' + (source.owner ? source.owner + '-' + source.name : foreign.name) + (source.pick ? '-' + source.pick : ''));
  const marketDir = path.join(getConfigDirectory(env), 'plugins', 'single', market);
  await mkdir(path.join(marketDir, '.claude-plugin'), { recursive: true });
  const name = await convertToClaudePlugin(dir, path.join(marketDir, 'plugin'), foreign);
  await writeFile(path.join(marketDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: market, owner: { name: source.owner || 'local' }, plugins: [{ name, source: './plugin' }] }, null, 2) + '\n');
  await addMarketplace(marketDir, { env, cwd: root });
  const result = await installPlugin(name + '@' + market, { env, root, scope });
  const options = foreign.format === 'gemini' && Array.isArray(foreign.manifest.settings) ? foreign.manifest.settings.map((s) => s && s.envVar).filter(Boolean) : [];
  return { installed: [result.id], message: 'Installed and enabled ' + result.id + ' (converted from a ' + foreign.label + ').' + (options.length ? ' It reads ' + options.join(', ') + ' from your environment, or set them with oasis plugin config ' + result.id + ' KEY=VALUE.' : ''), reload: true };
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
      run: async () => { const { addRemoteMcpServer } = await import('./mcp-remote-add.mjs'); const message = await addRemoteMcpServer(['--transport', source.transport, '--scope', scope, ...(source.headers || []).flatMap((h) => ['--header', h]), name, source.url], { root, env, approve: async () => true }); return { installed: [name], message, reload: true }; } };
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
  if (source.kind === 'stdio-mcp') {
    const name = slug(options.name || source.name, 'mcp');
    const keys = Object.keys(source.env || {});
    const entry = { command: source.command, args: source.args, ...(keys.length ? { env: source.env } : {}) };
    return { kind: 'stdio-mcp', title: 'MCP server ' + name, summary: 'Add the MCP server "' + name + '": runs ' + [source.command, ...source.args].join(' ') + ' when sessions start' + (keys.length ? ', with ' + keys.join(', ') + ' set' : '') + '.',
      run: async () => ({ ...(await writeStdioServer(name, entry, { root, env, scope })), reload: true }) };
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
          await rm(path.join(marketDir, 'plugin'), { recursive: true, force: true });
          await (await import('./plugin-copy.mjs')).copyPluginTree(fetched.dir, path.join(marketDir, 'plugin'));
        }
        await writeFile(path.join(marketDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: market, owner: { name: source.owner || 'local' }, plugins: [{ name: info.name, source: pluginSource }] }, null, 2) + '\n');
        await addMarketplace(marketDir, { env, cwd: root });
        const result = await installPlugin(info.name + '@' + market, { env, root, scope });
        return { installed: [result.id], message: 'Installed and enabled ' + result.id + '.', reload: true };
      }) };
  }
  if (info.type === 'codex-marketplace') {
    const wanted = source.pick ? info.plugins.find((p) => p.name === source.pick.toLowerCase()) : (info.plugins.length === 1 ? info.plugins[0] : null);
    if (!wanted) {
      await fetched.cleanup();
      const list = info.plugins.slice(0, 30).map((p) => p.name).join(', ');
      if (source.pick) throw new Error('The Codex marketplace ' + info.name + ' has no plugin called ' + source.pick + '. Plugins: ' + list + '.');
      return { kind: 'none', title: 'Codex marketplace ' + info.name, summary: '', run: async () => ({ installed: [], available: info.plugins.map((p) => p.name), message: 'The Codex marketplace ' + info.name + ' has ' + info.plugins.length + ' plugins: ' + list + '. Add one with ' + repoLabel + '#NAME.' }) };
    }
    const convert = await import('./plugin-convert.mjs');
    const foreign = (await convert.detectForeignPlugin(wanted.path)) || { format: 'codex', label: 'Codex plugin', name: wanted.name, description: wanted.description, version: '', manifest: { name: wanted.name } };
    const contents = await convert.describeForeignPlugin(wanted.path, foreign);
    return { ...base, kind: 'foreign-plugin', title: foreign.label + ' ' + foreign.name,
      summary: 'Install and enable the ' + foreign.label + ' "' + foreign.name + '" from ' + repoLabel + (contents.length ? ': ' + contents.join(', ') : '') + '. OASIS runs it as a Claude Code plugin.',
      run: () => done(() => installConverted(wanted.path, foreign, source, { env, root, scope })) };
  }
  if (info.type === 'foreign-plugin') {
    const convert = await import('./plugin-convert.mjs');
    let foreign = await convert.detectForeignPlugin(fetched.dir);
    // Like Gemini CLI, prefer the built archive from the latest GitHub release.
    const release = foreign.format === 'gemini' && source.owner && /github\.com/i.test(source.url || '') && !source.subdir && !source.local
      ? await convert.fetchGeminiRelease(source.owner, source.name, { env, fetchImpl: options.fetchImpl, ref: source.ref }) : null;
    if (release) foreign = (await convert.detectForeignPlugin(release.dir)) || foreign;
    const from = release ? release.dir : fetched.dir;
    const contents = release ? await convert.describeForeignPlugin(release.dir, foreign) : info.contents;
    return { ...base, kind: 'foreign-plugin', title: info.label + ' ' + info.name,
      cleanup: async () => { await fetched.cleanup(); if (release) await release.cleanup(); },
      summary: 'Install and enable the ' + info.label + ' "' + info.name + '" from ' + repoLabel + (release ? ' (release ' + release.tag + ', ' + release.asset + ')' : '') + (contents.length ? ': ' + contents.join(', ') : '') + '. OASIS runs it as a Claude Code plugin.',
      run: () => done(async () => { try { return await installConverted(from, foreign, source, { env, root, scope }); } finally { if (release) await release.cleanup(); } }) };
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
  // A variable nobody has set yet is reported after the install, not refused.
  const placeholders = Object.fromEntries([...JSON.stringify(entry).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].filter((m) => env[m[1]] === undefined).map((m) => [m[1], 'x']));
  const check = parseMcpServerEntries({ mcpServers: { [name]: entry } }, { ...env, ...placeholders }, scope);
  if (check.failures && check.failures.length) throw new Error('MCP server "' + name + '" is not usable: ' + check.failures[0].error);
  const file = scope === 'project' ? path.join(root, '.mcp.json') : path.join(getConfigDirectory(env), 'mcp.json');
  const parsed = (await readJsonFile(file)) || {};
  const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers) ? parsed.mcpServers : {};
  await mkdir(path.dirname(file), { recursive: true, ...(scope === 'user' ? { mode: 0o700 } : {}) });
  await writeFile(file, JSON.stringify({ ...parsed, mcpServers: { ...servers, [name]: entry } }, null, 2) + '\n', scope === 'user' ? { mode: 0o600 } : {});
  return { installed: [name], message: 'Added MCP server "' + name + '" (' + [entry.command, ...entry.args].join(' ') + ') in ' + file + '. It starts with your next session.' };
}

// Plan, ask once, install. approve(summary) -> boolean.
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;
const isSecretName = (key) => /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PAT\b/i.test(key);

function mcpFiles(root, env) {
  return [path.join(getConfigDirectory(env), 'mcp.json'), path.join(root, '.mcp.json')];
}

// Find an installed MCP server (user or project) or plugin by name or id.
async function findInstalled(name, { env, root }) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  for (const file of mcpFiles(root, env)) {
    const doc = await readJsonFile(file);
    const servers = doc && doc.mcpServers;
    if (servers && servers[wanted] && typeof servers[wanted] === 'object') return { type: 'mcp', name: wanted, file, doc, entry: servers[wanted] };
  }
  const { loadEnabledPlugins } = await import('./claude-plugins.mjs');
  const plugins = await loadEnabledPlugins(root, { env }).catch(() => []);
  const plugin = plugins.find((p) => p.id === wanted) || plugins.find((p) => p.name === wanted);
  return plugin ? { type: 'plugin', name: plugin.id, plugin } : null;
}

// Keys an installed add-on still needs: ${VAR} in an MCP entry that nothing
// sets, or plugin options with no value and no environment variable.
async function missingValues(names, { env, root }) {
  const out = {};
  for (const name of names || []) {
    const found = await findInstalled(name, { env, root });
    if (!found) continue;
    const need = new Set();
    if (found.type === 'mcp') {
      const text = JSON.stringify(found.entry);
      for (const m of text.matchAll(VAR)) if (!/:-/.test(m[0]) && env[m[1]] === undefined) need.add(m[1]);
    } else {
      const schema = (found.plugin.manifest && found.plugin.manifest.userConfig) || {};
      const values = found.plugin.options || found.plugin.config || {};
      for (const [key, option] of Object.entries(schema)) {
        if (option && option.required === false) continue;
        if (values[key] === undefined && env[key] === undefined && (!option || option.default === undefined) && /^[A-Z][A-Z0-9_]*$/.test(key)) need.add(key);
      }
    }
    if (need.size) out[found.name] = [...need];
  }
  return out;
}

// Save values (API keys and the like) for an installed MCP server or plugin.
// MCP values go into its entry in the owner-only config; plugin values become
// plugin options (secret ones in the keychain).
export async function configureInstalled(name, values, { env, root }) {
  const found = await findInstalled(name, { env, root });
  if (!found) return null;
  const keys = Object.keys(values);
  if (found.type === 'mcp') {
    const replace = (value) => typeof value === 'string' ? value.replace(VAR, (m, key) => key in values ? String(values[key]) : m) : value;
    const entry = JSON.parse(JSON.stringify(found.entry), (key, value) => replace(value));
    const loose = keys.filter((k) => !JSON.stringify(found.entry).includes('${' + k));
    if (entry.command) entry.env = { ...(entry.env || {}), ...Object.fromEntries(loose.filter((k) => !k.includes('-')).map((k) => [k, String(values[k])])) };
    else if (entry.url && loose.length) {
      // Remote servers take keys as headers: header names as given, and a
      // bare token as "Authorization: Bearer <token>".
      const headers = { ...(entry.headers || {}) };
      for (const k of loose) {
        const value = String(values[k]);
        if (/^[A-Z][a-z]+(-[A-Za-z]+)*$/.test(k) || /^x-/i.test(k)) headers[k] = value;
        else if (isSecretName(k)) headers.Authorization = /^(Bearer|Basic|token)\s/i.test(value) ? value : 'Bearer ' + value;
      }
      if (Object.keys(headers).length) entry.headers = headers;
    }
    const user = found.file === mcpFiles(root, env)[0];
    await writeFile(found.file, JSON.stringify({ ...found.doc, mcpServers: { ...found.doc.mcpServers, [found.name]: entry } }, null, 2) + '\n', user ? { mode: 0o600 } : {});
    return { type: 'mcp', name: found.name, keys, file: found.file };
  }
  const { setPluginOption } = await import('./claude-plugins.mjs');
  for (const key of keys) await setPluginOption(found.plugin, key, String(values[key]), { env });
  return { type: 'plugin', name: found.name, keys };
}

const valuesNote = (needs) => Object.entries(needs).map(([name, keys]) => name + ' needs ' + keys.join(', ')).join('; ');

export async function addAnything(raw, options = {}) {
  const values = options.values && typeof options.values === 'object' ? Object.fromEntries(Object.entries(options.values).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(k) && v !== undefined && v !== null && String(v) !== '')) : {};
  const where = { env: options.env || process.env, root: path.resolve(options.root || process.cwd()) };
  // Keys for something already installed: save them, no reinstall.
  if (Object.keys(values).length && (await findInstalled(raw, where))) {
    const target = await findInstalled(raw, where);
    const approve = options.approve || (async () => false);
    const summary = 'Save ' + Object.keys(values).join(', ') + ' for ' + (target.type === 'mcp' ? 'the MCP server "' + target.name + '" in ' + target.file : 'the plugin ' + target.name) + '? The values stay on this machine and are not shown.';
    if (!(await approve(summary, { kind: 'configure' }))) return { kind: 'configure', approved: false, installed: [], message: 'Nothing was saved.' };
    const saved = await configureInstalled(raw, values, where);
    const needs = await missingValues([saved.name], where);
    return { kind: 'configure', approved: true, installed: [saved.name], configured: saved.keys, reconnect: saved.type === 'mcp',
      message: 'Saved ' + saved.keys.join(', ') + ' for ' + saved.name + '.' + (Object.keys(needs).length ? ' Still missing: ' + valuesNote(needs) + '.' : '') };
  }
  const result = await addAnythingOnce(raw, options);
  if (!result.approved || !result.installed || !result.installed.length) return result;
  const names = result.installed;
  if (Object.keys(values).length) {
    for (const name of names) await configureInstalled(name, values, where).catch(() => null);
    result.configured = Object.keys(values);
  }
  const needs = await missingValues(names, where);
  if (Object.keys(needs).length) {
    result.needs = needs;
    const first = Object.keys(needs)[0];
    result.message += ' Not set yet: ' + valuesNote(needs) + '. Paste ' + (Object.values(needs).flat().some(isSecretName) ? 'the key' : 'the value') + ' in a chat ("use this for ' + first + ': ...") or set ' + Object.values(needs).flat().join(', ') + ' in your environment.';
    result.agentHint = 'Ask the user for ' + Object.values(needs).flat().join(', ') + ', then call add_extension with source "' + first + '" and env {' + needs[first].map((k) => '"' + k + '": "..."').join(', ') + '}.';
  }
  return result;
}

async function addAnythingOnce(raw, options = {}) {
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
