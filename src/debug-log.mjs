// Debug log (Claude Code's --debug [categories], --debug-file and /debug): timestamped lines
// for API requests, tool calls, hooks, MCP servers and permission decisions, written to
// <config>/debug/<session>.txt (or --debug-file). Categories filter what is written:
// "api,hooks" keeps only those, "!mcp" drops one, "all" keeps everything.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

export const DEBUG_CATEGORIES = ['api', 'tools', 'hooks', 'mcp', 'permissions', 'session'];
let state = { enabled: false, include: null, exclude: new Set(), file: null };

export function parseDebugCategories(spec) {
  const words = String(spec || 'all').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const include = new Set();
  const exclude = new Set();
  for (const word of words) {
    if (word === 'all' || word === '1' || word === 'true') continue;
    if (word.startsWith('!')) exclude.add(word.slice(1)); else include.add(word);
  }
  return { include: include.size ? include : null, exclude };
}

/** Turns logging on. Returns the log file path. */
export function enableDebug({ categories = 'all', file = null, env = process.env, sessionId = null } = {}) {
  const parsed = parseDebugCategories(categories);
  const target = file ? path.resolve(file) : path.join(getConfigDirectory(env), 'debug', (sessionId || 'oasis-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + process.pid) + '.txt');
  try { mkdirSync(path.dirname(target), { recursive: true }); } catch {}
  state = { enabled: true, ...parsed, file: target };
  debugLog('session', 'debug logging on (categories: ' + (categories || 'all') + ', node ' + process.version + ', ' + process.platform + ')');
  return target;
}

export function disableDebug() { debugLog('session', 'debug logging off'); state = { enabled: false, include: null, exclude: new Set(), file: null }; }
export function debugEnabled(category) { return state.enabled && (!category || ((!state.include || state.include.has(category)) && !state.exclude.has(category))); }
export function debugFile() { return state.file; }

// Masks likely secrets so the log is safe to share in bug reports.
function redact(text) {
  return String(text)
    .replace(/(authorization|x-api-key|api[-_]?key|token|secret|password)("?\s*[:=]\s*"?)([^"\s,}]{4,})/gi, (_, k, sep) => k + sep + '[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[bp]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,})/g, '[redacted]');
}

export function debugLog(category, message, data = undefined) {
  if (!debugEnabled(category)) return;
  let line = new Date().toISOString() + ' [' + category.toUpperCase() + '] ' + message;
  if (data !== undefined) { let text; try { text = typeof data === 'string' ? data : JSON.stringify(data); } catch { text = String(data); } line += ' ' + (text.length > 2000 ? text.slice(0, 2000) + '…' : text); }
  try { appendFileSync(state.file, redact(line) + '\n'); } catch {}
}
