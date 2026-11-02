import { atomicWriteFile } from './atomic-write.mjs';
// oasis mcp add --transport http|sse NAME URL [--header "Name: value"] [--scope user|project]
// Writes a Claude Code-style entry to ~/.config/oasis/mcp.json (user scope, the
// default) or ./.mcp.json (project scope), the files OASIS already reads.
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory, isLoopbackUrl } from './config.mjs';
import { parseMcpServerEntries } from './mcp-project.mjs';

const USAGE = 'Usage: oasis mcp add --transport http|sse NAME URL [--header "Name: value"] [--scope user|project]';
const SECRET_HEADER = /^(?:authorization|x-api-key|api-key|x-auth-token|cookie)$/i;

export function parseRemoteAddArgs(args) {
  const positional = [];
  const headers = {};
  let transport = '';
  let scope = 'user';
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => { if (inline !== undefined) return inline; if (i + 1 >= args.length) throw new Error(flag + ' needs a value.\n' + USAGE); return String(args[++i]); };
    if (flag === '--transport' || flag === '-t') transport = value().toLowerCase();
    else if (flag === '--scope' || flag === '-s') scope = value().toLowerCase();
    else if (flag === '--header' || flag === '-H') {
      const raw = value();
      const colon = raw.indexOf(':');
      if (colon <= 0) throw new Error('Headers look like "Name: value".');
      const key = raw.slice(0, colon).trim();
      if (!/^[A-Za-z0-9-]{1,100}$/.test(key)) throw new Error('Invalid header name: ' + key);
      headers[key] = raw.slice(colon + 1).trim();
    } else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg + '\n' + USAGE);
    else positional.push(arg);
  }
  if (transport === 'streamable-http') transport = 'http';
  if (transport !== 'http' && transport !== 'sse') throw new Error('--transport must be http or sse.\n' + USAGE);
  if (scope === 'local') scope = 'user';
  if (scope !== 'user' && scope !== 'project') throw new Error('--scope must be user or project.');
  if (positional.length !== 2) throw new Error(USAGE);
  const [name, url] = positional;
  return { name, url, transport, scope, headers };
}

export async function addRemoteMcpServer(args, { root = process.cwd(), env = process.env, approve = async () => true } = {}) {
  const { name, url, transport, scope, headers } = parseRemoteAddArgs(args);
  // Project files are usually committed: credentials must come from ${VAR} references there.
  if (scope === 'project') {
    for (const [key, value] of Object.entries(headers)) {
      if (SECRET_HEADER.test(key) && !/\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/.test(value)) {
        throw new Error('Header ' + key + ' would put a credential in .mcp.json, which is usually committed. Use a reference like "' + key + ': Bearer ${MY_TOKEN}" or --scope user.');
      }
    }
  }
  const entry = { type: transport, url, ...(Object.keys(headers).length ? { headers } : {}) };
  // Same validation the runtime applies when it loads the file.
  // ${VAR} references are resolved when a session starts, so unset ones are fine here.
  const referenced = [...new Set([...JSON.stringify(entry).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))];
  const unset = referenced.filter((key) => env[key] === undefined);
  const validationEnv = { ...env, ...Object.fromEntries(unset.map((key) => [key, 'unset'])) };
  const check = parseMcpServerEntries({ mcpServers: { [name]: entry } }, validationEnv, scope);
  if (check.failures.length) throw new Error('MCP server "' + name + '" is not usable: ' + check.failures[0].error);
  const normalized = check.servers[0].name;
  const file = scope === 'project' ? path.join(root, '.mcp.json') : path.join(getConfigDirectory(env), 'mcp.json');
  let parsed = {};
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read ' + file + ': ' + error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(file + ' does not contain a JSON object.');
  const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers) ? parsed.mcpServers : {};
  const replacing = Object.prototype.hasOwnProperty.call(servers, name);
  const shownHeaders = Object.entries(headers).map(([key, value]) => key + ': ' + (SECRET_HEADER.test(key) && !/\$\{/.test(value) ? '(hidden)' : value));
  const summary = (replacing ? 'Replace' : 'Add') + ' MCP server "' + name + '" (' + transport + ', ' + scope + ' scope)?\nURL: ' + url +
    (shownHeaders.length ? '\nHeaders: ' + shownHeaders.join('; ') : '') +
    '\nFile: ' + file + (isLoopbackUrl(url) ? '' : '\nThe server is remote; each of its tool calls still asks for approval by default.');
  if (!(await approve(summary))) return 'MCP configuration cancelled. Nothing was changed.';
  await mkdir(path.dirname(file), { recursive: true, ...(scope === 'user' ? { mode: 0o700 } : {}) });
  await atomicWriteFile(file, JSON.stringify({ ...parsed, mcpServers: { ...servers, [name]: entry } }, null, 2) + '\n', scope === 'user' ? { mode: 0o600 } : {});
  if (scope === 'user') { try { await chmod(file, 0o600); } catch {} }
  const next = scope === 'project' ? ' Project servers run after you trust the folder (oasis trust).' : '';
  const login = !Object.keys(headers).some((key) => /^authorization$/i.test(key)) ? ' If it needs sign-in, run oasis mcp login ' + normalized + '.' : '';
  const warn = unset.length ? ' Set ' + unset.join(', ') + ' before starting OASIS; the server is skipped while ' + (unset.length > 1 ? 'they are' : 'it is') + ' unset.' : '';
  return (replacing ? 'Updated' : 'Added') + ' MCP server "' + normalized + '" (' + transport + ') in ' + file + '. It starts with your next session.' + next + login + warn;
}

// oasis mcp remove NAME for servers in <oasis config>/mcp.json. Returns null when absent.
export async function removeUserMcpJsonServer(name, { env = process.env, approve = async () => true } = {}) {
  const file = path.join(getConfigDirectory(env), 'mcp.json');
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  const servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : null;
  const key = servers && Object.keys(servers).find((item) => item === name || item.toLowerCase().replace(/[^a-z0-9_-]/g, '-') === name);
  if (!key) return null;
  if (!(await approve('Remove MCP server "' + key + '" from ' + file + '?'))) return 'MCP removal cancelled.';
  const { [key]: removed, ...others } = servers;
  void removed;
  await atomicWriteFile(file, JSON.stringify({ ...parsed, mcpServers: others }, null, 2) + '\n', { mode: 0o600 });
  return 'Removed MCP server "' + key + '" from ' + file + '.';
}
