// Claude Code's "apiKeyHelper" setting: a shell command whose stdout is the API key.
// The key is cached for CLAUDE_CODE_API_KEY_HELPER_TTL_MS (default 5 minutes) and
// refreshed early when the provider answers 401/403.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';

const cache = new Map();
const DEFAULT_TTL = 5 * 60 * 1000;

export function helperTtl(env = process.env) {
  const raw = Number(env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS || env.OASIS_API_KEY_HELPER_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL;
}

export function runApiKeyHelper(command, options = {}) {
  return runHelperCommand(command, options, 'apiKeyHelper').then((out) => {
    const key = out.trim().split(/\r?\n/).pop() || '';
    if (!key) throw new Error('apiKeyHelper printed no API key.');
    if (/\s/.test(key) || key.length > 8192) throw new Error('apiKeyHelper output is not a single API key.');
    return key;
  });
}

export function runHelperCommand(command, options = {}, label = 'helper') {
  const env = options.env || process.env;
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.max(1, Math.min(5 * 60 * 1000, Math.floor(requestedTimeout))) : 30000;
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? (env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    let child;
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      handler(value);
    };
    const append = (current, chunk, limit) => (current + chunk.toString('utf8')).slice(-limit);
    try {
      child = spawn(shell, args, { cwd: options.cwd || process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...processTreeSpawnOptions() });
    } catch (error) {
      finish(reject, new Error(label + ' could not start: ' + error.message));
      return;
    }
    timer = setTimeout(() => {
      signalProcessTree(child, 'SIGKILL');
      finish(reject, new Error(label + ' timed out after ' + Math.round(timeoutMs / 1000) + 's.'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { out = append(out, chunk, 65536); });
    child.stderr.on('data', (chunk) => { err = append(err, chunk, 4096); });
    child.on('error', (error) => finish(reject, new Error(label + ' could not start: ' + error.message)));
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(label + ' exited with code ' + code + '. Stderr is not echoed because the helper may handle credentials.'));
      finish(resolve, out);
    });
  });
}

function helperCacheKey(command, options, env) {
  // The same command string can return different credentials in different
  // workspaces or environments. Do not share a cached key across those contexts.
  const cwd = path.resolve(options.cwd || process.cwd());
  const environment = Object.keys(env).sort().map((key) => [key, String(env[key])]);
  const digest = createHash('sha256').update(JSON.stringify(environment)).digest('hex');
  return String(command) + '\\0' + cwd + '\\0' + digest;
}

export async function apiKeyFromHelper(command, options = {}) {
  const env = options.env || process.env;
  const key = helperCacheKey(command, options, env);
  const entry = cache.get(key);
  if (entry && !options.refresh && Date.now() - entry.at < helperTtl(env)) return entry.pending;
  const pending = runApiKeyHelper(command, options);
  cache.set(key, { at: Date.now(), pending });
  pending.catch(() => { if (cache.get(key)?.pending === pending) cache.delete(key); });
  return pending;
}

export function clearApiKeyHelperCache() { cache.clear(); }

// Custom request headers for gateways and proxies (Claude Code's ANTHROPIC_CUSTOM_HEADERS):
// "Name: value" lines or a JSON object. Names must be HTTP tokens and values one line.
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'accept-encoding']);
export function parseCustomHeaders(value) {
  const out = {};
  if (!value) return out;
  let entries = [];
  if (typeof value === 'object' && !Array.isArray(value)) entries = Object.entries(value);
  else {
    const text = String(value).trim();
    if (text.startsWith('{')) { try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = Object.entries(parsed); } catch {} }
    else entries = text.split(/\r?\n/).map((line) => { const at = line.indexOf(':'); return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : null; }).filter(Boolean);
  }
  for (const [rawName, rawValue] of entries.slice(0, 50)) {
    const name = String(rawName).trim().toLowerCase();
    const headerValue = String(rawValue == null ? '' : rawValue).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/.test(name) || RESERVED_HEADERS.has(name)) continue;
    if (/[\r\n\0]/.test(headerValue) || headerValue.length > 8192) continue;
    out[name] = headerValue;
  }
  return out;
}

const headerCache = new Map();
/** Headers from ANTHROPIC_CUSTOM_HEADERS / OASIS_CUSTOM_HEADERS, config.customHeaders and a customHeadersHelper command (cached like apiKeyHelper). */
export async function customHeadersFor(config = {}, options = {}) {
  const env = options.env || process.env;
  const headers = { ...parseCustomHeaders(config.customHeaders), ...parseCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS), ...parseCustomHeaders(env.OASIS_CUSTOM_HEADERS) };
  const helper = String(config.customHeadersHelper || env.OASIS_CUSTOM_HEADERS_HELPER || '').trim();
  if (!helper) return headers;
  const key = helperCacheKey(helper, options, env);
  const entry = headerCache.get(key);
  let pending;
  if (entry && !options.refresh && Date.now() - entry.at < helperTtl(env)) pending = entry.pending;
  else {
    pending = runHelperCommand(helper, options, 'customHeadersHelper').then(parseCustomHeaders);
    headerCache.set(key, { at: Date.now(), pending });
    pending.catch(() => { if (headerCache.get(key)?.pending === pending) headerCache.delete(key); });
  }
  return { ...headers, ...await pending };
}
