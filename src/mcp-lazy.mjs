// Lazy MCP servers: `"lazy": true` on a server entry.
//
// Every MCP server normally starts with the session, which costs a process
// (and its memory) per stdio server even when the task never uses it. A lazy
// server starts only when one of its tools is first called. Its tool list
// comes from a manifest saved the last time the server started, so the model
// can still see and choose its tools; the tool schemas themselves are still
// deferred behind tool_search like any other MCP tool.
//
// Safety: a manifest only says which tools to advertise. When the server
// starts, every call is checked against the live tool list. If the tool is
// gone or its definition no longer matches what was advertised, the call is
// refused and the session's tool list is refreshed from the live server, so
// the normal description inspection and pinning apply to the real tools. A
// server without a manifest (first use, or its command/URL changed) starts
// eagerly once to record one. Resources and prompts are hidden until the
// server has started.

import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write.mjs';
import { getConfigDirectory } from './config.mjs';
import { toolFingerprint } from './mcp-trust.mjs';

const MAX_MANIFEST_TOOLS = 200;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export function serverStartOptions(spec) {
  return spec && typeof spec === 'object' && spec.lazy === true ? { lazy: true } : {};
}

function manifestPath(env) {
  return path.join(getConfigDirectory(env), 'mcp-manifests.json');
}

// What the server is: a change to its command, arguments, URL or working
// directory makes an older manifest stale.
export function manifestKey(config = {}) {
  const identity = { type: config.type || 'stdio', command: config.command || '', args: config.args || [], url: config.url || '', cwd: config.cwd || '' };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32);
}

async function readAll(env) {
  try {
    const text = await readFile(manifestPath(env), 'utf8');
    if (text.length > MAX_MANIFEST_BYTES) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : {};
  } catch { return {}; }
}

export async function loadManifest(config, env = process.env) {
  const entry = (await readAll(env))[config.name];
  if (!entry || entry.key !== manifestKey(config) || !Array.isArray(entry.tools)) return null;
  const tools = entry.tools.filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string').slice(0, MAX_MANIFEST_TOOLS);
  return { tools, savedAt: entry.savedAt || null };
}

export async function saveManifest(client, env = process.env) {
  const config = client && client.config;
  if (!config || !config.name || !Array.isArray(client.tools)) return;
  const servers = await readAll(env);
  servers[config.name] = {
    key: manifestKey(config),
    savedAt: new Date().toISOString(),
    tools: client.tools.slice(0, MAX_MANIFEST_TOOLS).map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {})
    }))
  };
  const file = manifestPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify({ version: 1, servers }, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Stands in for a server that has not started. `factory()` returns the real
 * (unstarted) client. Before start it reports the manifest's tools and only
 * the tools capability; afterwards every property comes from the real client.
 */
export function createLazyClient(config, { source, manifest, factory, env = process.env, onStarted = null } = {}) {
  const state = { real: null, starting: null };
  const advertised = new Map(manifest.tools.map((tool) => [tool.name, toolFingerprint(tool)]));
  const ensureStarted = async () => {
    if (state.real) return state.real;
    state.starting ||= (async () => {
      const client = factory();
      client.source = source;
      try { await client.start(); } catch (error) { client.close(); state.starting = null; throw error; }
      state.real = client;
      await saveManifest(client, env).catch(() => {});
      if (typeof onStarted === 'function') onStarted(client);
      return client;
    })();
    return await state.starting;
  };
  const own = {
    lazy: true,
    get started() { return Boolean(state.real); },
    ensureStarted,
    async callTool(name, args, options) {
      const client = await ensureStarted();
      const live = (client.tools || []).find((tool) => tool.name === name);
      const expected = advertised.get(name);
      if (!live || (expected && toolFingerprint(live) !== expected)) {
        throw new Error('MCP server ' + config.name + (live ? ' changed its tool ' + name + ' since it was last started' : ' no longer has a tool named ' + name) + '. The tool list has been refreshed; check the new definition before calling it again.');
      }
      return await client.callTool(name, args, options);
    },
    close() {
      if (state.real) state.real.close();
      else if (state.starting) state.starting.then((client) => client.close(), () => {});
    }
  };
  const placeholder = { config, source, tools: manifest.tools, capabilities: { tools: {} }, status: 'not started (lazy)' };
  return new Proxy(own, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop);
      if (state.real) {
        const value = state.real[prop];
        return typeof value === 'function' ? value.bind(state.real) : value;
      }
      return placeholder[prop];
    },
    set(target, prop, value) {
      if (state.real) state.real[prop] = value;
      else placeholder[prop] = value;
      return true;
    },
    has(target, prop) { return prop in target || (state.real ? prop in state.real : prop in placeholder); }
  });
}
