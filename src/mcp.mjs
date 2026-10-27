import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_LINE = 1024 * 1024;
const MAX_CONTENT = 24000;

export function getMcpConfigPath(env = process.env) {
  return path.join(getConfigDirectory(env), 'mcp-servers.json');
}

export async function loadMcpServers(options = {}) {
  const configPath = options.configPath || getMcpConfigPath(options.env || process.env);
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.servers)) {
      throw new Error('MCP configuration has an invalid shape.');
    }
    return {
      configPath,
      servers: parsed.servers.map(validateMcpServerConfig)
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { configPath, servers: [] };
    throw error;
  }
}

export function validateMcpServerConfig(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error('Each MCP server entry must be an object.');
  if (typeof server.name !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(server.name)) throw new Error('MCP server names must use lowercase letters, numbers, hyphens, and underscores.');
  if (typeof server.command !== 'string' || !server.command.trim() || server.command.length > 500) throw new Error('Each MCP server needs one executable command.');
  if (!/^[a-zA-Z0-9_./:\\-]+$/.test(server.command)) throw new Error('MCP server command must be one executable path, not shell syntax.');
  const args = server.args === undefined ? [] : server.args;
  if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || arg.length > 5000 || arg.includes('\0'))) throw new Error('MCP server arguments must be an array of short strings.');
  const passEnv = server.passEnv === undefined ? [] : server.passEnv;
  if (!Array.isArray(passEnv) || passEnv.length > 50 || passEnv.some((key) => typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error('MCP passEnv must contain environment variable names only.');
  const forbidden = passEnv.filter((key) => /^(?:PATH|HOME|SHELL|PWD|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/i.test(key));
  if (forbidden.length) throw new Error('MCP servers cannot override foundational process variables through passEnv.');
  return {
    name: server.name,
    command: server.command,
    args: [...args],
    passEnv: [...new Set(passEnv)],
    enabled: server.enabled !== false
  };
}

export async function saveMcpServers(servers, options = {}) {
  if (!Array.isArray(servers) || servers.length > 40) throw new Error('MCP configuration supports up to 40 servers.');
  const validated = servers.map(validateMcpServerConfig);
  const names = new Set();
  for (const server of validated) {
    if (names.has(server.name)) throw new Error('MCP server names must be unique.');
    names.add(server.name);
  }
  const configPath = options.configPath || getMcpConfigPath(options.env || process.env);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, servers: validated }, null, 2) + '\n', { mode: 0o600 });
  try { await chmod(configPath, 0o600); } catch {}
  return configPath;
}

function safeEnvironment(server, source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION|GITHUB_TOKEN|GH_TOKEN)/i.test(key)) continue;
    if (key === 'OASIS_COMMAND_ENV_ALLOWLIST') continue;
    env[key] = value;
  }
  for (const key of server.passEnv) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function compactText(result) {
  if (!result || typeof result !== 'object') return String(result);
  if (Array.isArray(result.content)) {
    const values = [];
    for (const block of result.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') values.push(block.text);
      else if (block && block.type === 'image') values.push('[MCP image content omitted from the text-only agent runtime]');
      else if (block && block.type === 'resource') values.push('[MCP resource content omitted; use the server-specific resource workflow]');
    }
    let text = values.join('\n\n');
    if (result.isError) text = 'MCP tool reported an error:\n' + text;
    return text.slice(0, MAX_CONTENT);
  }
  return JSON.stringify(result).slice(0, MAX_CONTENT);
}

export class McpServerClient {
  constructor(config, options = {}) {
    this.config = validateMcpServerConfig(config);
    this.root = options.root || process.cwd();
    this.env = options.env || process.env;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderrTail = '';
    this.tools = [];
    this.startPromise = null;
  }

  async start() {
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this._start();
    return await this.startPromise;
  }

  async _start() {
    if (!this.config.enabled) throw new Error('MCP server is disabled: ' + this.config.name);
    this.child = spawn(this.config.command, this.config.args, {
      cwd: this.root,
      env: safeEnvironment(this.config, this.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-6000);
    });
    this.child.on('error', (error) => this._failAll(new Error('MCP server ' + this.config.name + ' could not start: ' + error.message)));
    this.child.on('close', (code) => {
      this.closed = true;
      this._failAll(new Error('MCP server ' + this.config.name + ' exited' + (code === null ? '' : ' with code ' + code) + '.'));
    });

    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'oasis-oss', version: '0.2.0' }
    }, 15000);
    this._notify('notifications/initialized', {});
    const listed = await this._request('tools/list', {}, 15000);
    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    this.tools = tools.filter((tool) =>
      tool && typeof tool.name === 'string' &&
      /^[a-zA-Z0-9_.-]{1,80}$/.test(tool.name) &&
      tool.name !== '__proto__'
    ).slice(0, 80);
    return this.tools;
  }

  _onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE * 2) {
      this._failAll(new Error('MCP server output buffer exceeded the protocol limit.'));
      this.close();
      return;
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      if (line.length > MAX_LINE) {
        this._failAll(new Error('MCP server sent an oversized protocol message.'));
        continue;
      }
      let message;
      try { message = JSON.parse(line); } catch {
        this.stderrTail = (this.stderrTail + '\n[ignored non-JSON stdout from MCP server]').slice(-6000);
        continue;
      }
      if (message.id !== undefined && this.pending.has(String(message.id))) {
        const pending = this.pending.get(String(message.id));
        this.pending.delete(String(message.id));
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'MCP request failed.'));
        else pending.resolve(message.result || {});
      }
    }
  }

  _request(method, params = {}, timeoutMs = 30000) {
    if (!this.child || this.closed || !this.child.stdin.writable) return Promise.reject(new Error('MCP server is not running: ' + this.config.name));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error('MCP request timed out: ' + method));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  _notify(method, params = {}) {
    if (!this.child || this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(name, args, options = {}) {
    const schema = this.tools.find((tool) => tool.name === name);
    if (!schema) throw new Error('MCP tool is not available: ' + name);
    if (!options.autoApprove) {
      const ok = options.approval && await options.approval(
        'Call MCP server "' + this.config.name + '" tool "' + name + '" with arguments:\n' +
        JSON.stringify(args, null, 2).slice(0, 5000) +
        '\nMCP tools can read external data or change systems according to this server’s permissions.'
      );
      if (!ok) return { approved: false, message: 'MCP tool call was not approved. No call was made.' };
    }
    const result = await this._request('tools/call', { name, arguments: args }, 120000);
    return { isError: Boolean(result.isError), content: compactText(result), structuredContent: result.structuredContent };
  }

  _failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this._failAll(new Error('MCP server session closed.'));
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch {}
    }
  }
}

export async function connectMcpServers(options = {}) {
  const { servers } = await loadMcpServers(options);
  const clients = new Map();
  const failures = [];
  for (const config of servers.filter((item) => item.enabled)) {
    const client = new McpServerClient(config, options);
    try {
      await client.start();
      clients.set(config.name, client);
    } catch (error) {
      failures.push({ name: config.name, error: error.message });
      client.close();
    }
  }
  return { clients, failures };
}

export function mcpToolDefinitions(clients) {
  const definitions = [];
  const map = new Map();
  for (const [serverName, client] of clients) {
    for (const tool of client.tools) {
      const safeName = ('mcp_' + serverName + '_' + tool.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      if (map.has(safeName)) continue;
      const input = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
      definitions.push({
        type: 'function',
        function: {
          name: safeName,
          description: ('MCP server ' + serverName + ': ' + String(tool.description || tool.name)).slice(0, 1000),
          parameters: input
        }
      });
      map.set(safeName, { serverName, toolName: tool.name });
    }
  }
  return { definitions, map };
}

export async function callMappedMcpTool(session, safeName, args, options = {}) {
  const mapped = session.mcpToolMap && session.mcpToolMap.get(safeName);
  if (!mapped) throw new Error('Unknown MCP tool: ' + safeName);
  const client = session.mcpClients && session.mcpClients.get(mapped.serverName);
  if (!client) throw new Error('MCP server is unavailable: ' + mapped.serverName);
  return await client.callTool(mapped.toolName, args, options);
}

export function closeMcpClients(clients) {
  for (const client of clients.values()) client.close();
}
