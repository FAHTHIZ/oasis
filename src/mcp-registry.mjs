// oasis mcp search QUERY / oasis mcp install NAME
//
// Finds servers in the official MCP Registry (registry.modelcontextprotocol.io,
// the open catalogue run by the Model Context Protocol project) and turns a
// registry entry into a Claude Code-style mcp.json / .mcp.json entry:
//
//   npm     npx -y <package>@<version> ...        (stdio)
//   pypi    uvx <package>==<version> ...          (stdio)
//   oci     docker run -i --rm ... <image> ...    (stdio)
//   remote  { type: http|sse, url, headers }      (no local code)
//
// Versions are pinned, secrets are never written: required secrets become
// ${VAR} references resolved when a session starts. Nothing is written
// without the same confirmation `oasis mcp add` uses.
import { mkdir, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write.mjs';
import { getConfigDirectory, isLoopbackUrl } from './config.mjs';
import { parseMcpServerEntries } from './mcp-project.mjs';
import { onPathSync } from './clipboard-path.mjs';

const DEFAULT_REGISTRY = 'https://registry.modelcontextprotocol.io';
const USAGE = 'Usage: oasis mcp install REGISTRY_NAME [--name LOCAL_NAME] [--scope user|project] [--remote | --package npm|pypi|oci] [-- EXTRA_ARGS...]';

export function registryBase(env = process.env) {
  const base = String(env.OASIS_MCP_REGISTRY_URL || DEFAULT_REGISTRY).replace(/\/+$/, '');
  const url = new URL(base);
  if (url.protocol !== 'https:' && !isLoopbackUrl(url.toString())) throw new Error('OASIS_MCP_REGISTRY_URL must use https.');
  return base;
}

async function getJson(url, { fetchImpl = globalThis.fetch, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'oasis-cli' }, signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('The MCP Registry answered HTTP ' + response.status + '.');
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('The MCP Registry response was too large.');
    return JSON.parse(text);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The MCP Registry did not answer in time.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const officialMeta = (item) => (item && item._meta && item._meta['io.modelcontextprotocol.registry/official']) || {};

function kinds(server) {
  const out = [];
  for (const pkg of Array.isArray(server.packages) ? server.packages : []) if (pkg.registryType) out.push(pkg.registryType);
  for (const remote of Array.isArray(server.remotes) ? server.remotes : []) out.push(remote.type === 'sse' ? 'sse' : 'remote');
  return [...new Set(out)];
}

/** Search the registry. Returns compact, display-ready rows. */
export async function searchRegistry(query, { env = process.env, fetchImpl, limit = 20, signal } = {}) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Usage: oasis mcp search QUERY');
  // The registry matches names by substring and returns them alphabetically, so read a
  // few pages and rank locally (the vendor's own server should not be on page 3).
  // A one-word query also asks for publishers ending in it ("github/" finds
  // io.github.github/github-mcp-server among 800+ substring matches).
  const rows = [];
  const seen = new Set();
  const queries = /^[A-Za-z0-9_-]+$/.test(text) ? [[text + '/', 1], [text, 3]] : [[text, 3]];
  for (const [search, pages] of queries) for (let page = 0, cursor = ''; page < pages; page++) {
    const url = registryBase(env) + '/v0.1/servers?version=latest&limit=100&search=' + encodeURIComponent(search) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const body = await getJson(url, { fetchImpl, signal });
    for (const item of Array.isArray(body && body.servers) ? body.servers : []) {
      const server = item.server || item;
      const meta = officialMeta(item);
      if (!server.name || seen.has(server.name) || meta.status === 'deleted' || meta.status === 'deprecated') continue;
      seen.add(server.name);
      rows.push({
        name: String(server.name),
        title: server.title ? String(server.title) : '',
        description: String(server.description || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        version: String(server.version || ''),
        kinds: kinds(server),
        repository: server.repository && server.repository.url ? String(server.repository.url) : '',
        updated: String(meta.updatedAt || meta.publishedAt || '').slice(0, 10)
      });
    }
    cursor = body && body.metadata && body.metadata.nextCursor;
    if (!cursor) break;
  }
  const needle = text.toLowerCase();
  const score = (row) => {
    const [namespace, short = ''] = row.name.toLowerCase().split('/');
    const owner = namespace.split('.').pop();
    const repoOwner = (row.repository.match(/github\.com\/([^/]+)/i) || [])[1] || '';
    // Publisher named after the query (io.github.github/..., com.stripe/...) whose repository it owns.
    const vendor = owner === needle && (!repoOwner || repoOwner.toLowerCase() === needle) ? 0 : owner === needle ? 1 : 2;
    const match = short === needle || short === needle + '-mcp' || short === needle + '-mcp-server' || short === 'mcp-' + needle ? 0 : short.startsWith(needle) ? 1 : short.includes(needle) ? 2 : 3;
    return vendor * 100 + match * 10 + (row.repository ? 0 : 5) + (row.kinds.length ? 0 : 3);
  };
  rows.sort((a, b) => score(a) - score(b) || b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name));
  return rows.slice(0, limit);
}

export async function getRegistryServer(name, { env = process.env, fetchImpl, signal } = {}) {
  const id = String(name || '').trim();
  if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(id)) throw new Error('Registry names look like io.github.owner/server. Find one with oasis mcp search QUERY.');
  const body = await getJson(registryBase(env) + '/v0.1/servers/' + encodeURIComponent(id) + '/versions/latest', { fetchImpl, signal });
  const server = body && (body.server || body);
  if (!server || !server.name) throw new Error('No MCP Registry server named ' + id + '. Find one with oasis mcp search QUERY.');
  return server;
}

const envName = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';

// Registry values use {name} placeholders; mcp.json uses ${NAME} env references.
function templated(value, variables, prefix, needed) {
  return String(value).replace(/\{([A-Za-z0-9_-]+)\}/g, (_, key) => {
    const variable = variables && variables[key] || {};
    if (variable.default !== undefined && !variable.isSecret) return String(variable.default);
    const name = envName(prefix + '_' + key);
    needed.add(name);
    return '${' + name + '}';
  });
}

function argumentList(list, prefix, needed, problems) {
  const out = [];
  for (const arg of Array.isArray(list) ? list : []) {
    const raw = arg.value !== undefined ? arg.value : arg.default;
    const usesVariables = raw !== undefined && /\{[A-Za-z0-9_-]+\}/.test(String(raw));
    // Optional arguments that need user input are left out: the server's defaults apply.
    if (!arg.isRequired && (raw === undefined || (usesVariables && arg.variables && Object.values(arg.variables).some((v) => v.isSecret || v.isRequired === false || v.default === undefined)))) continue;
    if (raw === undefined) {
      if (arg.type === 'positional') { problems.push('needs a value for ' + (arg.valueHint || arg.name || 'a positional argument') + (arg.description ? ' (' + arg.description + ')' : '') + '; pass it after --'); continue; }
      problems.push('needs a value for ' + arg.name + (arg.description ? ' (' + arg.description + ')' : ''));
      continue;
    }
    const value = templated(raw, arg.variables, prefix, needed);
    if (arg.type === 'named' && arg.name) out.push(arg.name, value);
    else out.push(value);
  }
  return out;
}

const RUNTIME = { npm: 'npx', pypi: 'uvx', oci: 'docker' };

/**
 * Turn a registry server into an mcp.json entry. prefer: 'auto' | 'remote' | 'npm' | 'pypi' | 'oci'.
 * Returns { entry, kind, requiredEnv, optionalEnv, problems, runtime }.
 */
export function entryFromRegistry(server, { prefer = 'auto', env = process.env, extraArgs = [], localName } = {}) {
  const prefix = envName(localName || defaultLocalName(server.name));
  const packages = (Array.isArray(server.packages) ? server.packages : []).filter((pkg) => RUNTIME[pkg.registryType] && (!pkg.transport || pkg.transport.type === 'stdio'));
  const remotes = (Array.isArray(server.remotes) ? server.remotes : []).filter((remote) => remote.url && ['streamable-http', 'http', 'sse'].includes(remote.type));
  const remoteNeedsSecret = (remote) => (remote.headers || []).some((header) => header.isRequired && header.value === undefined);
  let choice = null;
  if (prefer === 'remote') { if (!remotes.length) throw new Error(server.name + ' has no remote endpoint. Try without --remote.'); choice = { remote: remotes[0] }; }
  else if (prefer !== 'auto') {
    const pkg = packages.find((item) => item.registryType === prefer);
    if (!pkg) throw new Error(server.name + ' has no ' + prefer + ' package. It offers: ' + (kinds(server).join(', ') || 'nothing OASIS can run') + '.');
    choice = { pkg };
  } else {
    // Remote first when it needs no pasted secret (no local code runs; OAuth via oasis mcp login),
    // then a package whose runtime is installed, then any package, then any remote.
    const openRemote = remotes.find((remote) => !remoteNeedsSecret(remote));
    const runnable = packages.find((pkg) => onPathSync(RUNTIME[pkg.registryType], env));
    choice = openRemote ? { remote: openRemote } : runnable ? { pkg: runnable } : packages[0] ? { pkg: packages[0] } : remotes[0] ? { remote: remotes[0] } : null;
  }
  if (!choice) throw new Error(server.name + ' has no package or remote endpoint OASIS can run (offers: ' + (kinds(server).join(', ') || 'none') + ').');
  const needed = new Set();
  const problems = [];
  const optionalEnv = [];
  if (choice.remote) {
    const remote = choice.remote;
    const headers = {};
    for (const header of Array.isArray(remote.headers) ? remote.headers : []) {
      if (!header.name || !/^[A-Za-z0-9-]{1,100}$/.test(header.name)) continue;
      if (header.value !== undefined) { if (header.isRequired || !/\{/.test(header.value)) headers[header.name] = templated(header.value, header.variables, prefix, needed); continue; }
      if (!header.isRequired) { optionalEnv.push(header.name + ' header' + (header.description ? ' (' + header.description + ')' : '')); continue; }
      const variable = envName(prefix + '_' + (/^authorization$/i.test(header.name) ? 'token' : header.name));
      needed.add(variable);
      headers[header.name] = (/^authorization$/i.test(header.name) ? 'Bearer ' : '') + '${' + variable + '}';
    }
    const entry = { type: remote.type === 'sse' ? 'sse' : 'http', url: templated(remote.url, remote.variables, prefix, needed), ...(Object.keys(headers).length ? { headers } : {}) };
    return { entry, kind: 'remote', requiredEnv: [...needed], optionalEnv, problems, runtime: null };
  }
  const pkg = choice.pkg;
  const version = pkg.version || server.version;
  const runtimeArgs = argumentList(pkg.runtimeArguments, prefix, needed, problems);
  const packageArgs = argumentList(pkg.packageArguments, prefix, needed, problems).concat(extraArgs.map(String));
  if (extraArgs.length) for (let i = problems.length - 1; i >= 0; i--) if (/pass it after --/.test(problems[i])) problems.splice(i, 1);
  const envEntries = {};
  for (const variable of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) {
    if (!variable.name || !/^[A-Z_][A-Z0-9_]*$/i.test(variable.name)) continue;
    if (variable.isRequired) {
      envEntries[variable.name] = variable.value !== undefined ? templated(variable.value, variable.variables, prefix, needed) : variable.default !== undefined && !variable.isSecret ? String(variable.default) : '${' + variable.name + '}';
      if (variable.value === undefined && (variable.default === undefined || variable.isSecret)) needed.add(variable.name);
    } else optionalEnv.push(variable.name + (variable.description ? ' (' + String(variable.description).slice(0, 100) + ')' : ''));
  }
  let command;
  let args;
  if (pkg.registryType === 'npm') { command = 'npx'; args = ['-y', ...runtimeArgs.filter((arg) => arg !== '-y' && arg !== '--yes'), pkg.identifier + (version && !/@[^/]*\d/.test(pkg.identifier.replace(/^@/, '')) ? '@' + version : ''), ...packageArgs]; }
  else if (pkg.registryType === 'pypi') { command = 'uvx'; args = [...runtimeArgs, pkg.identifier + (version && !/[=<>]/.test(pkg.identifier) ? '==' + version : ''), ...packageArgs]; }
  else {
    command = 'docker';
    const image = /[:@]/.test(pkg.identifier.split('/').pop()) || !version ? pkg.identifier : pkg.identifier + ':' + version;
    // Env values reach the container through -e NAME (value from the docker client's environment).
    const passEnv = Object.keys(envEntries).flatMap((name) => runtimeArgs.some((arg) => arg === name || arg.startsWith(name + '=')) ? [] : ['-e', name]);
    args = ['run', '-i', '--rm', ...passEnv, ...runtimeArgs, image, ...packageArgs];
  }
  const entry = { command, args, ...(Object.keys(envEntries).length ? { env: envEntries } : {}) };
  return { entry, kind: pkg.registryType, requiredEnv: [...needed], optionalEnv, problems, runtime: command };
}

// io.github.github/github-mcp-server -> github, com.notion/mcp -> notion,
// io.github.microsoft/playwright-mcp -> playwright.
export function defaultLocalName(registryName) {
  const [namespace, short = ''] = String(registryName).split('/');
  let name = short.replace(/[-_.]?mcp[-_.]?server$/i, '').replace(/^mcp[-_.]?server[-_.]?/i, '').replace(/[-_.]?mcp$/i, '').replace(/^mcp[-_.]/i, '');
  if (!name || /^(server|api|remote|official)$/i.test(name)) name = namespace.split('.').pop();
  return name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64) || 'mcp-server';
}

export function parseInstallArgs(args) {
  const out = { scope: 'user', prefer: 'auto', extraArgs: [] };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--') { out.extraArgs = args.slice(i + 1).map(String); break; }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => { if (inline !== undefined) return inline; if (i + 1 >= args.length) throw new Error(flag + ' needs a value.\n' + USAGE); return String(args[++i]); };
    if (flag === '--scope' || flag === '-s') out.scope = value().toLowerCase();
    else if (flag === '--name') out.name = value();
    else if (flag === '--remote') out.prefer = 'remote';
    else if (flag === '--package') out.prefer = value().toLowerCase();
    else if (flag === '--yes' || flag === '-y') out.yes = true;
    else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg + '\n' + USAGE);
    else positional.push(arg);
  }
  if (out.scope === 'local') out.scope = 'user';
  if (!['user', 'project'].includes(out.scope)) throw new Error('--scope must be user or project.');
  if (!['auto', 'remote', 'npm', 'pypi', 'oci'].includes(out.prefer)) throw new Error('--package must be npm, pypi or oci.');
  if (positional.length !== 1) throw new Error(USAGE);
  out.registryName = positional[0];
  if (out.name !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(out.name)) throw new Error('--name may use letters, digits, - and _ (up to 64).');
  return out;
}

export async function installFromRegistry(args, { root = process.cwd(), env = process.env, approve = async () => true, fetchImpl, signal } = {}) {
  const options = parseInstallArgs(args);
  const server = await getRegistryServer(options.registryName, { env, fetchImpl, signal });
  const localName = options.name || defaultLocalName(server.name);
  const plan = entryFromRegistry(server, { prefer: options.prefer, env, extraArgs: options.extraArgs, localName });
  if (plan.problems.length) throw new Error(server.name + ' ' + plan.problems.join('; ') + '.\n' + USAGE);
  // Same validation the runtime applies; unset ${VAR}s are fine here (resolved at session start).
  const unset = plan.requiredEnv.filter((key) => env[key] === undefined);
  const check = parseMcpServerEntries({ mcpServers: { [localName]: plan.entry } }, { ...env, ...Object.fromEntries(unset.map((key) => [key, 'unset'])) }, options.scope);
  if (check.failures.length) throw new Error('The registry entry for ' + server.name + ' is not usable: ' + check.failures[0].error);
  const file = options.scope === 'project' ? path.join(root, '.mcp.json') : path.join(getConfigDirectory(env), 'mcp.json');
  let parsed = {};
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read ' + file + ': ' + error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(file + ' does not contain a JSON object.');
  const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers) ? parsed.mcpServers : {};
  const replacing = Object.prototype.hasOwnProperty.call(servers, localName);
  const how = plan.kind === 'remote'
    ? 'Remote endpoint: ' + plan.entry.url + (plan.entry.headers ? '\nHeaders: ' + Object.entries(plan.entry.headers).map(([k, v]) => k + ': ' + v).join('; ') : '') + '\nNo local code runs; each tool call still asks for approval by default.'
    : 'Runs: ' + [plan.entry.command, ...plan.entry.args].join(' ') + (plan.entry.env ? '\nEnvironment: ' + Object.entries(plan.entry.env).map(([k, v]) => k + '=' + v).join(' ') : '') +
      '\nThis downloads and runs third-party ' + plan.kind + ' code in your user account when sessions start. Review the source before approving.';
  const summary = (replacing ? 'Replace' : 'Add') + ' MCP server "' + localName + '" from the MCP Registry (' + options.scope + ' scope)?\n' +
    'Registry entry: ' + server.name + (server.version ? ' ' + server.version : '') + (server.repository && server.repository.url ? '\nSource: ' + server.repository.url : '\nSource: (no repository listed)') + '\n' + how + '\nFile: ' + file;
  if (!(await approve(summary))) return 'MCP installation cancelled. Nothing was changed.';
  await mkdir(path.dirname(file), { recursive: true, ...(options.scope === 'user' ? { mode: 0o700 } : {}) });
  await atomicWriteFile(file, JSON.stringify({ ...parsed, mcpServers: { ...servers, [localName]: plan.entry } }, null, 2) + '\n', options.scope === 'user' ? { mode: 0o600 } : {});
  if (options.scope === 'user') { try { await chmod(file, 0o600); } catch {} }
  const notes = [];
  if (unset.length) notes.push('Set ' + unset.join(', ') + ' before starting OASIS; the server is skipped while ' + (unset.length > 1 ? 'they are' : 'it is') + ' unset.');
  if (plan.runtime && !onPathSync(plan.runtime, env)) notes.push(plan.runtime + ' is not on PATH yet; install ' + ({ npx: 'Node.js', uvx: 'uv (https://docs.astral.sh/uv/)', docker: 'Docker' }[plan.runtime]) + ' first.');
  if (plan.kind === 'remote' && !plan.entry.headers) notes.push('If it needs sign-in, run oasis mcp login ' + localName + '.');
  if (plan.optionalEnv.length) notes.push('Optional settings you can add to the entry: ' + plan.optionalEnv.slice(0, 6).join('; ') + '.');
  if (options.scope === 'project') notes.push('Project servers run after you trust the folder (oasis trust).');
  return (replacing ? 'Updated' : 'Added') + ' MCP server "' + localName + '" (' + plan.kind + ') in ' + file + '. It starts with your next session.' + (notes.length ? '\n' + notes.join('\n') : '');
}

export function formatSearchResults(rows, query) {
  if (!rows.length) return 'No MCP Registry servers match "' + query + '".';
  const lines = rows.map((row) => row.name + (row.version ? ' ' + row.version : '') + '  [' + (row.kinds.join(', ') || 'no runnable entry') + ']' + (row.updated ? '  ' + row.updated : '') +
    '\n    ' + (row.title ? row.title + ': ' : '') + (row.description || '(no description)') + (row.repository ? '\n    ' + row.repository : ''));
  return lines.join('\n') + '\n\nInstall one with: oasis mcp install NAME   (from the official MCP Registry; review the source first)';
}
