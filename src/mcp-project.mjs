// Claude Code-compatible MCP configuration and the remote (HTTP/SSE) MCP clients.
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
import { debugLog } from './debug-log.mjs';
import { readFile } from 'node:fs/promises';
import { oasisVersion } from './version.mjs';
import { spawn } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import path from 'node:path';
import { isLoopbackUrl } from './config.mjs';
import { serverToolFilters } from './mcp-trust.mjs';
import { loadMcpExtras } from './mcp-extras.mjs';
import { redactAuditValue } from './tool-kernel.mjs';
import { validateToolArguments } from './tool-schema-validation.mjs';
import { authRequiredError, createOAuthFetch, getStoredToken, loadMcpClientSdk, OasisOAuthProvider, fetchMcpSameOrigin, refreshExpiringToken, rememberRequiredScope, routeMcpFetch, sameMcpEndpoint } from './mcp-oauth.mjs';

import { clientCapabilities, handleServerNotification, handleServerRequest } from './mcp-client-features.mjs';
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_CONTENT = 24000;
const MAX_HEADERS_HELPER_OUTPUT_BYTES = 64 * 1024;
const MAX_HEADERS_HELPER_STDERR_BYTES = 4000;
function mcpAbortReason(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : 'MCP request was cancelled.');
  error.name = 'AbortError';
  return error;
}

const DEFAULT_HEADERS_HELPER_TIMEOUT_MS = 10000;

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
function claudeJsonPath(env = process.env) {
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
      const toolFilters = serverToolFilters(spec);
      const type = String(spec.type || (spec.url ? 'http' : 'stdio')).toLowerCase();
      if (type === 'http' || type === 'streamable-http' || type === 'sse') {
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
        servers.push({ name, type: type === 'sse' ? 'sse' : 'http', url: url.toString(), headers, ...(oauth ? { oauth } : {}), ...(spec.headersHelper ? { headersHelper: spec.headersHelper, ...(env.CLAUDE_PLUGIN_ROOT ? { pluginRoot: env.CLAUDE_PLUGIN_ROOT } : {}) } : {}), ...toolFilters, source });
      } else if (type === 'stdio') {
        const extraEnv = {};
        for (const [key, value] of Object.entries(spec.env || {})) {
          if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || /^(PATH|HOME|SHELL|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/i.test(key)) throw new Error('env cannot set ' + key);
          extraEnv[key] = expandVariables(value, env);
        }
        // A working directory: plugin servers get plugin-root paths; a relative one is under the workspace.
        let cwd;
        if (spec.cwd !== undefined) {
          if (typeof spec.cwd !== 'string' || !spec.cwd.trim() || spec.cwd.includes('\0')) throw new Error('cwd must be a directory path');
          cwd = expandVariables(spec.cwd, env);
        }
        servers.push({ name, command: String(spec.command || ''), args: Array.isArray(spec.args) ? spec.args.map((arg) => expandVariables(arg, env)) : [], passEnv: [], enabled: true, extraEnv, ...(cwd ? { cwd } : {}), ...toolFilters, source });
      } else {
        throw new Error('transport "' + type + '" is not supported (use stdio, http or sse)');
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

// ---------- Remote transports: the official MCP client SDK ----------
//
// Streamable HTTP and legacy HTTP+SSE run on @modelcontextprotocol/client (the
// SDK that passes the MCP conformance suite): session handling, SSE parsing,
// resumption and reconnects, protocol negotiation and OAuth. OASIS keeps the
// parts that are policy rather than protocol: static headers and headersHelper,
// the OAuth endpoint guard and token store (mcp-oauth.mjs), the 4 MiB response
// bound, tool-name filtering, approvals, and the server -> client handlers in
// mcp-client-features.mjs.

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function boundedResponse(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE) {
    response.body?.cancel().catch(() => {});
    throw new Error('MCP response exceeded 4 MiB.');
  }
  if (!response.body || NULL_BODY_STATUS.has(response.status)) return response;
  let total = 0;
  const limited = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE) controller.error(new Error('MCP response exceeded 4 MiB.'));
      else controller.enqueue(chunk);
    }
  }));
  return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function plainHeaderObject(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

const TASK_MAX_MS = 2 * 60 * 60 * 1000;

// Task augmentation needs the server's tasks.requests.tools.call capability;
// "required" tools must use it and "optional" tools do (long jobs then skip
// the request timeout). Absent or "forbidden" means a plain call.
export function useMcpTask(client, tool) {
  const caps = client && client.capabilities;
  if (!(caps && caps.tasks && caps.tasks.requests && caps.tasks.requests.tools && caps.tasks.requests.tools.call)) return false;
  const support = tool && tool.execution && tool.execution.taskSupport;
  return support === 'required' || support === 'optional';
}

// Non-spec (extension) methods need a result schema; this Standard Schema passes results through.
const ANY_RESULT = Object.freeze({ '~standard': Object.freeze({ version: 1, vendor: 'oasis', validate: (value) => ({ value }) }) });

function sdkMessage(error) {
  return String(error && error.message || error).replace(/^MCP error -?\d+:\s*/, '');
}

// Streamable HTTP MCP client with the same surface as McpServerClient.
// Grace period before a long MCP task moves to the background (ms); -1 waits.
// OASIS_MCP_TASK_BACKGROUND=0 or CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND=1 always waits.
export function mcpTaskBackgroundMs(env = process.env) {
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_MCP_TASK_BACKGROUND || '')) || /^(1|true)$/i.test(String(env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND || ''))) return -1;
  const raw = Number(env.OASIS_MCP_TASK_BACKGROUND_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 600000) : 5000;
}

export class McpHttpClient {
  constructor(config, options = {}) {
    this.config = { name: config.name, url: config.url, headers: config.headers || {}, enabled: true, type: config.type === 'sse' ? 'sse' : 'http', ...(config.oauth ? { oauth: config.oauth } : {}), ...(config.headersHelper ? { headersHelper: config.headersHelper, pluginRoot: config.pluginRoot } : {}), ...serverToolFilters(config) };
    this.helperHeaders = null;
    this.fetch = options.fetch || fetch;
    this.env = options.env || process.env;
    this.explicitAuth = Object.keys(this.config.headers).some((key) => key.toLowerCase() === 'authorization');
    this.tools = [];
    this.closed = false;
    this.activeRequests = new Set();
    this.activeHelpers = new Set();
    this.host = options.host || null;
    this.sdk = null;
    this.transport = null;
    this.oauthProvider = null;
    this.lastStatus = 0;
    this.startPromise = null;
    // Production is capped at 10 seconds; shorter injected timeouts make cleanup tests fast.
    const requestedHelperTimeout = options.headersHelperTimeoutMs;
    this.headersHelperTimeoutMs = Number.isSafeInteger(requestedHelperTimeout)
      ? Math.min(DEFAULT_HEADERS_HELPER_TIMEOUT_MS, Math.max(25, requestedHelperTimeout))
      : DEFAULT_HEADERS_HELPER_TIMEOUT_MS;
  }

  get sessionId() { return this.transport && this.transport.sessionId || null; }
  get protocolVersion() { return this.client && typeof this.client.getNegotiatedProtocolVersion === 'function' ? this.client.getNegotiatedProtocolVersion() : (this.transport && this.transport._protocolVersion) || null; }

  // headersHelper: a shell command printing a JSON object of headers (short-lived tokens).
  // Runs before the first request and again after a 401; its headers override static ones.
  async _helperHeaders(refresh = false) {
    if (this.closed) throw new Error('MCP server session closed.');
    if (!this.config.headersHelper) return {};
    if (this.helperHeaders && !refresh) return this.helperHeaders;
    const env = { ...this.env, CLAUDE_CODE_MCP_SERVER_NAME: this.config.name, CLAUDE_CODE_MCP_SERVER_URL: this.config.url, ...(this.config.pluginRoot ? { CLAUDE_PLUGIN_ROOT: this.config.pluginRoot } : {}) };
    const output = await new Promise((resolve, reject) => {
      const child = spawn(this.config.headersHelper, {
        shell: true, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        ...processTreeSpawnOptions()
      });
      this.activeHelpers.add(child);
      let out = '';
      let outBytes = 0;
      let err = '';
      let oversized = false;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timeoutMs = this.headersHelperTimeoutMs;
      const timeoutLabel = timeoutMs >= 1000 && timeoutMs % 1000 === 0
        ? (timeoutMs / 1000) + 's'
        : timeoutMs + 'ms';
      const timer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL');
        finish(new Error('headersHelper timed out after ' + timeoutLabel));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        if (oversized || settled) return;
        if (outBytes + chunk.byteLength > MAX_HEADERS_HELPER_OUTPUT_BYTES) {
          const remainingBytes = Math.max(0, MAX_HEADERS_HELPER_OUTPUT_BYTES - outBytes);
          if (remainingBytes) out += chunk.subarray(0, remainingBytes).toString('utf8');
          outBytes += remainingBytes;
          oversized = true;
          signalProcessTree(child, 'SIGKILL');
          finish(new Error('headersHelper output exceeded 64 KiB'));
          return;
        }
        out += chunk.toString('utf8');
        outBytes += chunk.byteLength;
      });
      child.stderr.on('data', (chunk) => {
        if (settled) return;
        const tail = chunk.byteLength > MAX_HEADERS_HELPER_STDERR_BYTES
          ? chunk.subarray(-MAX_HEADERS_HELPER_STDERR_BYTES).toString('utf8')
          : chunk.toString('utf8');
        err = (err + tail).slice(-MAX_HEADERS_HELPER_STDERR_BYTES);
      });
      child.on('error', (error) => {
        this.activeHelpers.delete(child);
        finish(this.closed ? new Error('MCP server session closed.') : error);
      });
      child.on('close', (code) => {
        this.activeHelpers.delete(child);
        if (this.closed) return finish(new Error('MCP server session closed.'));
        if (oversized) return finish(new Error('headersHelper output exceeded 64 KiB'));
        if (code === 0) finish(null, out);
        else finish(new Error('headersHelper exited with ' + code + (err.trim() ? ': ' + err.trim().slice(0, 300) : '')));
      });
    });
    if (this.closed) throw new Error('MCP server session closed.');
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

  // The fetch the SDK uses for MCP endpoint traffic: static headers, then
  // headersHelper headers (re-run once after a 401), a close-aware abort signal
  // and the response bound. OAuth endpoint traffic goes to the guarded fetch.
  async _mcpFetch(input, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    // close() ends the server-side session with one DELETE (cached headers, short timeout).
    if (method === 'DELETE') {
      return await fetchMcpSameOrigin(this.fetch, input, { ...init, headers: { ...this.config.headers, ...plainHeaderObject(init.headers), ...(this.helperHeaders || {}) }, signal: AbortSignal.timeout(5000) });
    }
    if (this.closed) throw new Error('MCP server session closed.');
    const controller = new AbortController();
    const outer = init.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    }
    this.activeRequests.add(controller);
    try {
      for (let attempt = 0; ; attempt++) {
        const extra = await this._helperHeaders(attempt > 0);
        if (this.closed) throw new Error('MCP server session closed.');
        const headers = { ...this.config.headers, ...plainHeaderObject(init.headers), ...extra };
        const response = await fetchMcpSameOrigin(this.fetch, input, { ...init, headers, signal: controller.signal });
        this.lastStatus = response.status;
        if (response.status === 401 && this.config.headersHelper && attempt === 0) {
          await response.body?.cancel().catch(() => {});
          continue;
        }
        if (method !== 'POST') return response;
        return boundedResponse(response);
      }
    } finally {
      if (method !== 'GET') this.activeRequests.delete(controller);
    }
  }

  _isMcpUrl(url) { return sameMcpEndpoint(url, this.config.url); }

  _createTransport(sdk, options) {
    return new sdk.StreamableHTTPClientTransport(new URL(this.config.url), options);
  }

  _translate(error) {
    if (this.closed) return new Error('MCP server session closed.');
    if (error && error.code === 'MCP_AUTH_REQUIRED') return error;
    if (error && ((this.sdk && this.sdk.InsufficientScopeError && error instanceof this.sdk.InsufficientScopeError) || 'requiredScope' in Object(error))) {
      const scope = error.requiredScope || '';
      rememberRequiredScope(this.config, scope, this.env).catch(() => {});
      const needed = new Error('MCP server ' + this.config.name + ' needs broader access' + (scope ? ' (scope: ' + String(scope).slice(0, 200) + ')' : '') + '. Run oasis mcp login ' + this.config.name + ' (or /mcp login ' + this.config.name + ' in the terminal).');
      needed.code = 'MCP_AUTH_REQUIRED';
      needed.requiredScope = scope;
      return needed;
    }
    if (/Endpoint origin does not match/i.test(String(error && error.message))) {
      return new Error('MCP server ' + this.config.name + ' announced a message endpoint on a different origin; refusing it.');
    }
    const status = error && typeof error.status === 'number' ? error.status
      : /Non-200 status code \((\d{3})\)/.test(String(error && error.message)) ? Number(/Non-200 status code \((\d{3})\)/.exec(String(error.message))[1])
      : error && error.data && typeof error.data.status === 'number' ? error.data.status
      : this.sdk && error instanceof this.sdk.UnauthorizedError ? 401 : 0;
    const helperAuth = Object.keys(this.helperHeaders || {}).some((key) => key.toLowerCase() === 'authorization');
    if (status === 401 && !this.explicitAuth && !helperAuth) return authRequiredError(this.config);
    if (status === 401 || status === 403) return new Error('MCP server ' + this.config.name + ' rejected the credentials (HTTP ' + status + '). Check the headers in .mcp.json.');
    if (status) return new Error('MCP server ' + this.config.name + ' returned HTTP ' + status + '.');
    if (error && error.code === 'REQUEST_TIMEOUT') return new Error('MCP request to ' + this.config.name + ' timed out.');
    if (error && error.name === 'AbortError') return new Error('MCP request to ' + this.config.name + ' timed out.');
    const result = new Error(sdkMessage(error));
    if (error && typeof error.code === 'number') result.rpcCode = error.code;
    return result;
  }

  async _request(method, params = {}, timeoutMs = 30000, signal = undefined, raw = false) {
    if (this.closed) throw new Error('MCP server session closed.');
    if (!this.client) throw new Error('MCP server ' + this.config.name + ' is not connected.');
    if (signal && signal.aborted) throw mcpAbortReason(signal);
    const requestOptions = { timeout: timeoutMs, ...(signal ? { signal } : {}) };
    try {
      try {
        // raw: task-augmented results are not the method's normal result shape.
        if (raw) return await this.client.request({ method, params }, ANY_RESULT, requestOptions) || {};
        return await this.client.request({ method, params }, requestOptions) || {};
      } catch (error) {
        if (!(error instanceof TypeError) || !/not a spec method/.test(error.message)) throw error;
        return await this.client.request({ method, params }, ANY_RESULT, requestOptions) || {};
      }
    } catch (error) {
      // The SDK may normalize an AbortSignal rejection. Prefer the caller's
      // reason so the agent can distinguish cancellation from a real timeout.
      if (signal && signal.aborted) throw mcpAbortReason(signal);
      throw this._translate(error);
    }
  }

  // Transport options for remote servers: headersHelper first (when it supplies
  // Authorization, OAuth stays out of the way), then saved OAuth credentials.
  async _transportOptions() {
    await this._helperHeaders(false);
    const helperAuth = Object.keys(this.helperHeaders || {}).some((key) => key.toLowerCase() === 'authorization');
    const useOAuth = !this.explicitAuth && !helperAuth;
    let storedToken = null;
    if (useOAuth) {
      try { storedToken = await getStoredToken(this.config.url, this.env); } catch {}
      if (storedToken) await refreshExpiringToken(this.config, { env: this.env, fetch: this.fetch }).catch(() => false);
    }
    // Without saved credentials there is nothing to refresh: a 401 means "run oasis mcp login".
    this.oauthProvider = useOAuth && storedToken ? new OasisOAuthProvider(this.config, { env: this.env }) : null;
    const oauthFetch = createOAuthFetch(this.config.url, { fetch: this.fetch });
    const transportFetch = routeMcpFetch((url) => this._isMcpUrl(url), (input, init) => this._mcpFetch(input, init), oauthFetch);
    return { fetch: transportFetch, ...(this.oauthProvider ? { authProvider: this.oauthProvider } : {}), onInsufficientScope: 'throw' };
  }

  async start() {
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this._start();
    return await this.startPromise;
  }

  // Fire-and-forget notification (used by channels for permission relay requests).
  _notify(method, params = {}) {
    if (!this.client || this.closed) return;
    Promise.resolve().then(() => this.client.notification({ method, params })).catch((error) => {
      this.stderrTail = ((this.stderrTail || '') + '\n[notify ' + method + '] ' + sdkMessage(error).slice(0, 200)).slice(-6000);
    });
  }

  async _start() {
    const sdk = this.sdk = await loadMcpClientSdk();
    if (this.closed) throw new Error('MCP server session closed.');
    this.transport = this._createTransport(sdk, await this._transportOptions());
    this.client = new sdk.Client({ name: 'oasis-oss', version: oasisVersion() }, { capabilities: clientCapabilities() });
    this.client.fallbackRequestHandler = async (request) => {
      const reply = await handleServerRequest(this, request);
      if (reply.error) throw new sdk.ProtocolError(reply.error.code, reply.error.message);
      return reply.result;
    };
    this.client.fallbackNotificationHandler = async (notification) => { await handleServerNotification(this, notification); };
    for (const method of ['roots/list', 'elicitation/create']) {
      try { this.client.setRequestHandler(method, (request) => this.client.fallbackRequestHandler(request)); } catch {}
    }
    for (const method of ['notifications/tools/list_changed', 'notifications/message']) {
      try { this.client.setNotificationHandler(method, (notification) => handleServerNotification(this, notification)); } catch {}
    }
    this.client.onerror = (error) => {
      const line = '[transport] ' + sdkMessage(error).slice(0, 300);
      this.stderrTail = ((this.stderrTail || '') + '\n' + line).slice(-6000);
    };
    try {
      await this.client.connect(this.transport, { timeout: 15000 });
    } catch (error) {
      throw this._translate(error);
    }
    const init = {
      protocolVersion: this.protocolVersion,
      capabilities: this.client.getServerCapabilities() || {},
      instructions: this.client.getInstructions ? this.client.getInstructions() : undefined,
      serverInfo: this.client.getServerVersion ? this.client.getServerVersion() : undefined
    };
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
    const registeredTool = this.tools.find((tool) => tool.name === name);
    if (!registeredTool) throw new Error('MCP tool is not available: ' + name);
    if (options.signal && options.signal.aborted) throw mcpAbortReason(options.signal);
    if (!options.autoApprove) {
      const ok = options.approval && await options.approval(
        'Call MCP server "' + this.config.name + '" tool "' + name + '" with arguments:\n' + JSON.stringify(redactAuditValue(args), null, 2).slice(0, 5000) +
        '\nMCP tools can read external data or change systems according to this server’s permissions.');
      if (!ok) return { approved: false, message: 'MCP tool call was not approved. No call was made.' };
    }
    if (options.signal && options.signal.aborted) throw mcpAbortReason(options.signal);
    const requestedTimeout = Number(options.timeoutMs ?? 120000);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(900000, Math.max(1, Math.floor(requestedTimeout)))
      : 120000;
    const result = useMcpTask(this, registeredTool)
      ? await this._callToolAsTask(registeredTool, args, options)
      : await this._request('tools/call', { name, arguments: args }, timeoutMs, options.signal);
    // MCP output schemas apply to structuredContent rather than display text.
    // Validate it when present; preserve text-only legacy responses.
    const outputSchema = registeredTool.outputSchema || options.outputSchema;
    if (!result.isError && outputSchema && typeof outputSchema === 'object' && result.structuredContent !== undefined) {
      const validation = await validateToolArguments(outputSchema, result.structuredContent, { dialect: '2020-12' });
      if (!validation.valid) {
        const detail = validation.schemaError || (validation.errors || []).join('; ');
        throw new Error('MCP server ' + this.config.name + ' returned invalid structured output for tool ' + name + ': ' + detail);
      }
    }
    return { isError: Boolean(result.isError), content: compactResult(result), ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) };
  }

  // MCP tasks run through the official @modelcontextprotocol/ext-tasks
  // requester: it creates the task, polls tasks/get at the server's interval,
  // reads the result, routes mid-task input and cancels on interrupt. Long
  // jobs are bound by the task deadline, not the per-request timeout.
  async _callToolAsTask(tool, args, options = {}) {
    const ext = await import('@modelcontextprotocol/ext-tasks/client');
    if (!this.taskSession) {
      this.taskSession = ext.createTaskSessionFromClient(this.client, {
        endpointId: 'oasis:' + this.config.name,
        onError: (error) => debugLog('mcp', this.config.name + ' task session: ' + sdkMessage(error).slice(0, 300))
      });
    }
    const deadline = AbortSignal.timeout(Math.min(TASK_MAX_MS, Number(options.taskTimeoutMs) || TASK_MAX_MS));
    // The turn's Esc/interrupt cancels the task only until it moves to the
    // background; after that only the task deadline or session close ends it.
    const turnLink = new AbortController();
    const onTurnAbort = () => turnLink.abort(options.signal.reason);
    if (options.signal) {
      if (options.signal.aborted) onTurnAbort();
      else options.signal.addEventListener('abort', onTurnAbort, { once: true });
    }
    const signal = AbortSignal.any([turnLink.signal, deadline]);
    const unlinkTurn = () => { if (options.signal) options.signal.removeEventListener('abort', onTurnAbort); };
    const execution = await this.taskSession.callTool(tool.name, args || {}, {
      declaration: ext.toolDeclarationFromMcpTool(tool),
      signal,
      requestTimeoutMs: 30000,
      task: { preference: 'prefer' }
    });
    this.activeTasks ||= new Map();
    const taskId = execution.kind === 'task' ? String(execution.handle.taskId) : null;
    if (taskId) this.activeTasks.set(taskId, { tool: tool.name, status: 'working', startedAt: Date.now() });
    const settle = (async () => {
    try {
      const { outcome } = await execution.settle({
        signal,
        onEvent: (event) => {
          const view = ext.taskViewFromExecutionEvent(event);
          if (!view || !taskId) return;
          this.activeTasks.set(taskId, { ...this.activeTasks.get(taskId), status: view.status, statusMessage: view.statusMessage });
          debugLog('mcp', this.config.name + ' task ' + taskId + ' ' + view.status + (view.statusMessage ? ': ' + String(view.statusMessage).slice(0, 200) : ''));
        }
      });
      if (outcome.status === 'cancelled') return { isError: true, content: [{ type: 'text', text: 'MCP task was cancelled by the server' + (outcome.task && outcome.task.statusMessage ? ': ' + outcome.task.statusMessage : '.') }] };
      if (outcome.status === 'failed') return { isError: true, content: [{ type: 'text', text: 'MCP task failed: ' + sdkMessage(outcome.error) + (outcome.task && outcome.task.statusMessage ? ' (' + outcome.task.statusMessage + ')' : '') }] };
      return outcome.result || {};
    } catch (error) {
      if (taskId) await execution.cancel().catch(() => {});
      if (turnLink.signal.aborted && options.signal && options.signal.aborted) throw mcpAbortReason(options.signal);
      if (deadline.aborted) throw new Error('MCP task on ' + this.config.name + ' did not finish in time; it was cancelled.');
      throw this._translate(error);
    } finally {
      unlinkTurn();
      if (taskId) this.activeTasks.delete(taskId);
      await execution.close().catch(() => {});
    }
    })();
    // Claude Code behaviour: a task still running after a short grace period
    // moves to the background, the turn continues, and the result arrives as a
    // notification. Without a background sink (headless callers, tests) or
    // with OASIS_MCP_TASK_BACKGROUND=0, the call waits as before.
    const graceMs = mcpTaskBackgroundMs(options.env || process.env);
    if (!taskId || typeof options.onBackgroundTask !== 'function' || graceMs < 0) return await settle;
    let timer = null;
    const moved = await Promise.race([
      settle.then(() => false, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), graceMs); if (timer.unref) timer.unref(); })
    ]);
    clearTimeout(timer);
    if (!moved) return await settle;
    unlinkTurn();
    try { options.onBackgroundTask({ server: this.config.name, tool: tool.name, taskId, settled: settle.then((result) => ({ isError: Boolean(result && result.isError), content: compactResult(result || {}) }), (error) => ({ isError: true, content: [{ type: 'text', text: sdkMessage(error) }] })) }); }
    catch (error) { debugLog('mcp', 'background task sink failed: ' + sdkMessage(error).slice(0, 200)); }
    return { isError: false, backgrounded: true, content: [{ type: 'text', text: 'MCP task ' + taskId + ' (' + this.config.name + ' ' + tool.name + ') is still running, so it moved to the background. Its result arrives as a notification when it finishes; continue with other work and do not call the tool again for the same request.' }] };
  }

  close() {
    if (this.closed) return;
    const transport = this.transport;
    const client = this.client;
    const terminate = transport && transport.sessionId && typeof transport.terminateSession === 'function'
      ? transport.terminateSession().catch(() => {})
      : Promise.resolve();
    this.closed = true;
    for (const child of this.activeHelpers) signalProcessTree(child, 'SIGKILL');
    terminate.finally(() => {
      for (const controller of this.activeRequests) controller.abort();
      this.activeRequests.clear();
      if (client) client.close().catch(() => {});
    });
  }
}

// Legacy HTTP+SSE transport (MCP 2024-11-05), still used by many hosted servers.
// The SDK's SSEClientTransport opens the event stream, waits for the endpoint
// event (refusing one on another origin) and POSTs each message there. Headers,
// headersHelper and OAuth behave exactly as for Streamable HTTP.
export class McpSseClient extends McpHttpClient {
  constructor(config, options = {}) {
    super({ ...config, type: 'sse' }, options);
  }

  // The stream URL plus the message endpoint the server announced (same origin, checked by the SDK).
  _isMcpUrl(url) {
    const endpoint = this.transport && this.transport._endpoint;
    return sameMcpEndpoint(url, this.config.url) || Boolean(endpoint && sameMcpEndpoint(url, String(endpoint)));
  }

  // Some servers answer a POST with the JSON-RPC reply inline instead of on the
  // stream. That is outside the 2024-11-05 transport, but cheap to accept: hand
  // the reply to the SDK as if it had arrived on the stream.
  async _mcpFetch(input, init = {}) {
    const response = await super._mcpFetch(input, init);
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'POST' || !response.ok || !/application\/json/i.test(response.headers.get('content-type') || '')) return response;
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const messages = (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item && item.jsonrpc === '2.0' && (item.id !== undefined || typeof item.method === 'string'));
    if (messages.length) queueMicrotask(() => { for (const message of messages) this.transport && this.transport.onmessage && this.transport.onmessage(message); });
    return new Response('Accepted', { status: 202 });
  }

  _createTransport(sdk, options) {
    const { onInsufficientScope, ...rest } = options;
    return new sdk.SSEClientTransport(new URL(this.config.url), rest);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.activeHelpers) signalProcessTree(child, 'SIGKILL');
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    if (this.client) this.client.close().catch(() => {});
  }
}
