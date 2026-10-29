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
  const env = options.env || process.env;
  const timeoutMs = options.timeoutMs || 30000;
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
      finish(reject, new Error('apiKeyHelper could not start: ' + error.message));
      return;
    }
    timer = setTimeout(() => {
      signalProcessTree(child, 'SIGKILL');
      finish(reject, new Error('apiKeyHelper timed out after ' + Math.round(timeoutMs / 1000) + 's.'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { out = append(out, chunk, 65536); });
    child.stderr.on('data', (chunk) => { err = append(err, chunk, 4096); });
    child.on('error', (error) => finish(reject, new Error('apiKeyHelper could not start: ' + error.message)));
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error('apiKeyHelper exited with code ' + code + (err.trim() ? ': ' + err.trim().slice(0, 300) : '')));
      const key = out.trim().split(/\r?\n/).pop() || '';
      if (!key) return finish(reject, new Error('apiKeyHelper printed no API key.'));
      if (/\s/.test(key) || key.length > 8192) return finish(reject, new Error('apiKeyHelper output is not a single API key.'));
      finish(resolve, key);
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
