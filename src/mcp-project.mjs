// Claude Code-compatible MCP configuration and the Streamable HTTP transport.
//
// .mcp.json in the workspace root (loaded only for trusted workspaces):
//   {
//     "mcpServers": {
//       "github":   { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
//                     "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
//       "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"],
//                     "env": { "DATABASE_URL": "${DATABASE_URL}" } }
//     }
//   }
// "${VAR}" and "${VAR:-default}" expand from the host environment when the session
// starts; expanded values are never written back to disk.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isLoopbackUrl } from './config.mjs';
import { loadMcpExtras } from './mcp-extras.mjs';
import { oauthHeader, refreshStoredToken } from './mcp-oauth.mjs';

import { clientCapabilities, routeServerMessage, MCP_CLIENT_PROTOCOL_VERSION } from './mcp-client-features.mjs';
const PROTOCOL_VERSION = MCP_CLIENT_PROTOCOL_VERSION;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_CONTENT = 24000;

export function expandVariables(value, env = process.env) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name, fallback) => {
    const found = env[name];
    if (found !== undefined && found !== '') return found;
    if (fallback !== undefined) return fallback;
    throw new Error('environment variable ' + name + ' is not set');
  });
}

export function normalizeServerName(name) {
  let safe = String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40);
  if (!/^[a-z]/.test(safe)) safe = ('s_' + safe).slice(0, 40);
  return safe;
}

// Returns { servers: [...], failures: [...] }; each server carries `source`.
export async function loadProjectMcpServers(root, options = {}) {
  const env = options.env || process.env;
  const file = path.join(path.resolve(root), '.mcp.json');
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { servers: [], failures: [], file: null };
    return { servers: [], failures: [{ name: '.mcp.json', error: 'could not be read: ' + error.message }], file };
  }
  const { servers, failures } = parseMcpServerEntries(parsed, env, 'project');
  return { servers, failures, file };
}

// Claude Code keeps `claude mcp add` servers in ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json):
// top-level "mcpServers" is the user scope and projects[<abs path>].mcpServers is the local scope.
// Both are written by the user, so (unlike .mcp.json) they do not need workspace trust.
export function claudeJsonPath(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || env.HOME || env.USERPROFILE || '';
  return base ? path.join(base, '.claude.json') : null;
}

// <oasis config>/mcp.json: user-scope servers in the Claude/.mcp.json format (written by
// `oasis import`; hand-editable). Supports http servers and stdio env values.
export async function loadUserMcpJson(options = {}) {
  const env = options.env || process.env;
  const { getConfigDirectory } = await import('./config.mjs');
  const file = options.file || path.join(getConfigDirectory(env), 'mcp.json');
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { servers: [], failures: [], file };
    return { servers: [], failures: [{ name: 'mcp.json', error: 'could not be read: ' + error.message }], file };
  }
  const result = parseMcpServerEntries(parsed || {}, env, 'user-json');
  return { ...result, file };
}

export async function loadClaudeCodeMcpServers(root, options = {}) {
  const env = options.env || process.env;
  const empty = { local: [], user: [], failures: [], file: null };
  if (env.OASIS_IGNORE_CLAUDE_MCP === '1' || env.OASIS_IGNORE_CLAUDE_SETTINGS === '1') return empty;
  const file = options.file || claudeJsonPath(env);
  if (!file) return empty;
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return empty;
    return { ...empty, failures: [{ name: '~/.claude.json', error: 'could not be read: ' + error.message }] };
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const resolved = path.resolve(root);
  let projectEntry = null;
  if (parsed.projects && typeof parsed.projects === 'object') {
    for (const [key, value] of Object.entries(parsed.projects)) {
      if (path.resolve(key) === resolved) { projectEntry = value; break; }
    }
  }
  const local = projectEntry && typeof projectEntry === 'object' ? parseMcpServerEntries(projectEntry, env, 'claude-local') : { servers: [], failures: [] };
  const user = parseMcpServerEntries(parsed, env, 'claude-user');
  return { local: local.servers, user: user.servers, failures: [...local.failures, ...user.failures].map((f) => ({ ...f, name: 'claude:' + f.name })), file };
}

// Parses a Claude-style { mcpServers: { name: spec } } object (used by .mcp.json and --mcp-config).
export function parseMcpServerEntries(parsed, env = process.env, source = 'project') {
  const entries = parsed && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers) ? Object.entries(parsed.mcpServers) : [];
  const servers = [];
  const failures = [];
  for (const [rawName, spec] of entries.slice(0, 40)) {
    const name = normalizeServerName(rawName);
    try {
      if (!spec || typeof spec !== 'object') throw new Error('entry must be an object');
      if (spec.disabled === true || spec.enabled === false) continue;
      const type = String(spec.type || (spec.url ? 'http' : 'stdio')).toLowerCase();
      if (type === 'http' || type === 'streamable-http') {
        const url = new URL(expandVariables(spec.url, env));
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackUrl(url.toString()))) throw new Error('remote MCP servers must use HTTPS (HTTP only for localhost)');
        const headers = {};
        for (const [key, value] of Object.entries(spec.headers || {})) {
          if (!/^[A-Za-z0-9-]{1,100}$/.test(key)) throw new Error('invalid header name ' + key);
          headers[key] = expandVariables(value, env);
        }
        let oauth = null;
        if (spec.oauth && typeof spec.oauth === 'object') {
          oauth = {};
          if (typeof spec.oauth.clientId === 'string') oauth.clientId = expandVariables(spec.oauth.clientId, env);
          if (typeof spec.oauth.clientSecret === 'string') oauth.clientSecret = expandVariables(spec.oauth.clientSecret, env);
          if (Array.isArray(spec.oauth.scopes) || typeof spec.oauth.scopes === 'string') oauth.scopes = spec.oauth.scopes;
          if (Number.isInteger(spec.oauth.callbackPort) && spec.oauth.callbackPort > 1023 && spec.oauth.callbackPort < 65536) oauth.callbackPort = spec.oauth.callbackPort;
        }
        if (spec.headersHelper !== undefined && (typeof spec.headersHelper !== 'string' || !spec.headersHelper.trim())) throw new Error('headersHelper must be a command string');
        servers.push({ name, type: 'http', url: url.toString(), headers, ...(oauth ? { oauth } : {}), ...(spec.headersHelper ? { headersHelper: spec.headersHelper, ...(env.CLAUDE_PLUGIN_ROOT ? { pluginRoot: env.CLAUDE_PLUGIN_ROOT } : {}) } : {}), source });
      } else if (type === 'stdio') {
        const extraEnv = {};
        for (const [key, value] of Object.entries(spec.env || {})) {
          if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || /^(PATH|HOME|SHELL|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/i.test(key)) throw new Error('env cannot set ' + key);
          extraEnv[key] = expandVariables(value, env);
        }
        servers.push({ name, command: String(spec.command || ''), args: Array.isArray(spec.args) ? spec.args.map((arg) => expandVariables(arg, env)) : [], passEnv: [], enabled: true, extraEnv, source });
      } else {
        throw new Error('transport "' + type + '" is not supported (use stdio or http)');
      }
    } catch (error) {
      failures.push({ name, error: error.message });
    }
  }
  return { servers, failures };
}

function compactResult(result) {
  if (!result || typeof result !== 'object') return String(result);
  if (!Array.isArray(result.content)) return JSON.stringify(result).slice(0, MAX_CONTENT);
  const parts = [];
  for (const block of result.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block && block.type === 'image') parts.push('[MCP image content omitted]');
    else if (block && block.type === 'resource') parts.push(block.resource && typeof block.resource.text === 'string' ? block.resource.text : '[MCP resource omitted]');
  }
  return ((result.isError ? 'MCP tool reported an error:\n' : '') + parts.join('\n\n')).slice(0, MAX_CONTENT);
}

async function readBoundedResponseText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE) {
    await response.body?.cancel().catch(() => {});
    throw new Error('MCP response exceeded 4 MiB.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) throw new Error('MCP response exceeded 4 MiB.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function readSseResponse(response, id, onMessage = null) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE) {
    await response.body?.cancel().catch(() => {});
    throw new Error('MCP response exceeded 4 MiB.');
  }
  if (!response.body) throw new Error('MCP server returned an empty response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_RESPONSE) throw new Error('MCP response exceeded 4 MiB.');
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let message;
        try { message = JSON.parse(data); } catch { continue; }
        if (message && typeof message.method === 'string') { if (onMessage) Promise.resolve(onMessage(message)).catch(() => {}); continue; }
        if (message && String(message.id) === String(id) && (message.result !== undefined || message.error)) return message;
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  throw new Error('MCP server closed the stream without a response.');
}

// Minimal Streamable HTTP MCP client with the same surface as McpServerClient.
export class McpHttpClient {
  constructor(config, options = {}) {
    this.config = { name: config.name, url: config.url, headers: config.headers || {}, enabled: true, type: 'http', ...(config.oauth ? { oauth: config.oauth } : {}), ...(config.headersHelper ? { headersHelper: config.headersHelper, pluginRoot: config.pluginRoot } : {}) };
    this.helperHeaders = null;
    this.fetch = options.fetch || fetch;
    this.env = options.env || process.env;
    this.explicitAuth = Object.keys(this.config.headers).some((key) => key.toLowerCase() === 'authorization');
    this.tools = [];
    this.sessionId = null;
    this.nextId = 1;
    this.closed = false;
    this.host = options.host || null;
  }

  // headersHelper: a shell command printing a JSON object of headers (short-lived tokens).
  // Runs before the first request and again after a 401; its headers override static ones.
  async _helperHeaders(refresh = false) {
    if (!this.config.headersHelper) return {};
    if (this.helperHeaders && !refresh) return this.helperHeaders;
    const { spawn } = await import('node:child_process');
    const env = { ...this.env, CLAUDE_CODE_MCP_SERVER_NAME: this.config.name, CLAUDE_CODE_MCP_SERVER_URL: this.config.url, ...(this.config.pluginRoot ? { CLAUDE_PLUGIN_ROOT: this.config.pluginRoot } : {}) };
    const output = await new Promise((resolve, reject) => {
      const child = spawn(this.config.headersHelper, { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('headersHelper timed out after 10s')); }, 10000);
      child.stdout.on('data', (chunk) => { out += chunk; if (out.length > 65536) child.kill('SIGKILL'); });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error('headersHelper exited with ' + code + (err.trim() ? ': ' + err.trim().slice(0, 300) : ''))); });
    });
    let parsed;
    try { parsed = JSON.parse(output); } catch { throw new Error('MCP server ' + this.config.name + ': headersHelper must print a JSON object of headers.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP server ' + this.config.name + ': headersHelper must print a JSON object of headers.');
    const headers = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('MCP server ' + this.config.name + ': headersHelper returned an invalid header ' + key);
      headers[key] = value;
    }
    this.helperHeaders = headers;
    return headers;
  }

  async _post(message, timeoutMs = 30000, retried = false) {
    const extra = await this._helperHeaders(false);
    const helperAuth = Object.keys(extra).some((key) => key.toLowerCase() === 'authorization');
    const authorization = this.explicitAuth || helperAuth ? null : await oauthHeader(this.config.url, { env: this.env, fetch: this.fetch }).catch(() => null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(this.config.url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          ...this.config.headers,
          ...extra,
          ...(authorization ? { authorization } : {}),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {})
        },
        body: JSON.stringify(message)
      });
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (response.status === 401 && this.config.headersHelper && !retried) {
        await this._helperHeaders(true);
        clearTimeout(timer);
        return await this._post(message, timeoutMs, true);
      }
      if (response.status === 401 && authorization && !retried) {
        const refreshed = await refreshStoredToken(this.config.url, { env: this.env, fetch: this.fetch }).catch(() => null);
        if (refreshed) { clearTimeout(timer); return await this._post(message, timeoutMs, true); }
      }
      if (response.status === 401 && !this.explicitAuth && !helperAuth) {
        const error = new Error('MCP server ' + this.config.name + ' needs sign-in. Run oasis mcp login ' + this.config.name + ' (or /mcp login ' + this.config.name + ' in the terminal).');
        error.code = 'MCP_AUTH_REQUIRED';
        throw error;
      }
      if (response.status === 401 || response.status === 403) throw new Error('MCP server ' + this.config.name + ' rejected the credentials (HTTP ' + response.status + '). Check the headers in .mcp.json.');
      if (!response.ok && response.status !== 202) throw new Error('MCP server ' + this.config.name + ' returned HTTP ' + response.status + '.');
      if (message.id === undefined || message.method === undefined || response.status === 202 || response.status === 204) return null;
      const type = response.headers.get('content-type') || '';
      const onServerMessage = (incoming) => routeServerMessage(this, incoming, (reply) => this._post(reply, 30000));
      const reply = type.includes('text/event-stream') ? await readSseResponse(response, message.id, onServerMessage) : JSON.parse(await readBoundedResponseText(response));
      const matched = Array.isArray(reply) ? reply.find((item) => String(item.id) === String(message.id)) : reply;
      if (!matched) throw new Error('MCP server sent no matching response.');
      if (matched.error) throw new Error(matched.error.message || 'MCP request failed.');
      return matched.result || {};
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('MCP request to ' + this.config.name + ' timed out.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  _request(method, params = {}, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('MCP server session closed.'));
    return this._post({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs);
  }

  async start() {
    const init = await this._request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: clientCapabilities(), clientInfo: { name: 'oasis-oss', version: '0.2.0' } }, 15000);
    this.protocolVersion = init && init.protocolVersion || PROTOCOL_VERSION;
    await this._post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 10000).catch(() => {});
    await this.refreshTools();
    await loadMcpExtras(this, init);
    return this.tools;
  }

  async refreshTools() {
    const listed = await this._request('tools/list', {}, 15000);
    this.tools = (Array.isArray(listed.tools) ? listed.tools : [])
      .filter((tool) => tool && typeof tool.name === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(tool.name) && tool.name !== '__proto__')
      .slice(0, 80);
    return this.tools;
  }

  async callTool(name, args, options = {}) {
    if (!this.tools.find((tool) => tool.name === name)) throw new Error('MCP tool is not available: ' + name);
    if (!options.autoApprove) {
      const ok = options.approval && await options.approval(
        'Call MCP server "' + this.config.name + '" tool "' + name + '" with arguments:\n' + JSON.stringify(args, null, 2).slice(0, 5000) +
        '\nMCP tools can read external data or change systems according to this server’s permissions.');
      if (!ok) return { approved: false, message: 'MCP tool call was not approved. No call was made.' };
    }
    const result = await this._request('tools/call', { name, arguments: args }, 120000);
    return { isError: Boolean(result.isError), content: compactResult(result), structuredContent: result.structuredContent };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionId) {
      this.fetch(this.config.url, { method: 'DELETE', headers: { ...this.config.headers, 'mcp-session-id': this.sessionId } }).catch(() => {});
    }
  }
}
