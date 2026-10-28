// Claude Code's "apiKeyHelper" setting: a shell command whose stdout is the API key.
// The key is cached for CLAUDE_CODE_API_KEY_HELPER_TTL_MS (default 5 minutes) and
// refreshed early when the provider answers 401/403.
import { spawn } from 'node:child_process';

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
    const child = spawn(shell, args, { cwd: options.cwd || process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('apiKeyHelper timed out after ' + Math.round(timeoutMs / 1000) + 's.')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (out.length < 65536) out += chunk; });
    child.stderr.on('data', (chunk) => { if (err.length < 4096) err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error('apiKeyHelper could not start: ' + error.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const key = out.trim().split(/\r?\n/).pop() || '';
      if (code !== 0) return reject(new Error('apiKeyHelper exited with code ' + code + (err.trim() ? ': ' + err.trim().slice(0, 300) : '')));
      if (!key) return reject(new Error('apiKeyHelper printed no API key.'));
      if (/\s/.test(key) || key.length > 8192) return reject(new Error('apiKeyHelper output is not a single API key.'));
      resolve(key);
    });
  });
}

export async function apiKeyFromHelper(command, options = {}) {
  const env = options.env || process.env;
  const entry = cache.get(command);
  if (entry && !options.refresh && Date.now() - entry.at < helperTtl(env)) return entry.pending;
  const pending = runApiKeyHelper(command, options);
  cache.set(command, { at: Date.now(), pending });
  pending.catch(() => { if (cache.get(command)?.pending === pending) cache.delete(command); });
  return pending;
}

export function clearApiKeyHelperCache() { cache.clear(); }
