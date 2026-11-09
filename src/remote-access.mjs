// Remote access for the browser workspace: which Host names are accepted,
// when a request counts as HTTPS (directly or through a trusted reverse
// proxy), a persistent access key, and a limiter for wrong keys.
//
// The defaults stay strict: loopback or literal IP Host headers only (DNS
// rebinding protection), a fresh random key per start, and no proxy headers
// trusted. Each relaxation is an explicit option:
//   publicUrl / allowedHosts  accept these host names (for a domain or tunnel)
//   trustProxy                believe X-Forwarded-* from a proxy on this computer
//   persistent access key     the same key across restarts, stored 0600
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const MIN_ACCESS_KEY_LENGTH = 32;
export const ACCESS_KEY_FILE = 'web-access-key';

// "https://oasis.example.com/", "oasis.example.com:8443", "*.ts.net" → host-name patterns (ports are not part of the match).
export function normalizeAllowedHost(value) {
  let text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try { text = new URL(text).host; } catch { return ''; }
  }
  text = text.replace(/\/.*$/, '');
  const wildcard = text.startsWith('*.');
  const bare = wildcard ? text.slice(2) : text;
  const match = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(bare);
  if (!match) return '';
  const name = match[1];
  if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return '';
  if (!HOSTNAME_RE.test(name) && isIP(name.replace(/^\[|\]$/g, '')) === 0) return '';
  if (wildcard && (isIP(name) > 0 || !name.includes('.'))) return ''; // "*.com" is too broad
  return (wildcard ? '*.' : '') + name;
}

export function parseAllowedHosts(list) {
  const values = Array.isArray(list) ? list : String(list || '').split(',');
  return [...new Set(values.map(normalizeAllowedHost).filter(Boolean))];
}

function hostnameOf(hostHeader) {
  try { return new URL('http://' + hostHeader).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; }
}

export function hostMatches(hostname, allowedHosts = []) {
  const name = String(hostname || '').toLowerCase();
  if (!name) return false;
  for (const pattern of allowedHosts) {
    const bare = pattern.replace(/:\d+$/, '');
    if (bare.startsWith('*.')) { if (name.endsWith(bare.slice(1)) && name.length > bare.length - 1) return true; }
    else if (bare.replace(/^\[|\]$/g, '') === name) return true;
  }
  return false;
}

export function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^::ffff:/, '');
  return value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

// The proxy is trusted only when it connects from this computer, so a remote
// client cannot claim HTTPS or another address by sending the headers itself.
function fromTrustedProxy(req, trustProxy) {
  return Boolean(trustProxy) && isLoopbackAddress(req.socket && req.socket.remoteAddress);
}

export function requestProtocol(req, { trustProxy = false } = {}) {
  if (req.socket && req.socket.encrypted) return 'https:';
  if (fromTrustedProxy(req, trustProxy)) {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (forwarded === 'https' || forwarded === 'http') return forwarded + ':';
  }
  return 'http:';
}

export function requestIsSecure(req, options = {}) {
  return requestProtocol(req, options) === 'https:';
}

export function clientAddress(req, { trustProxy = false } = {}) {
  const direct = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (fromTrustedProxy(req, trustProxy)) {
    const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (first && isIP(first.replace(/^::ffff:/, ''))) return first.replace(/^::ffff:/, '');
  }
  return direct;
}

// Host header check (DNS rebinding) plus a same-origin check for browser requests.
export function hostAllowed(req, { allowedHosts = [], trustProxy = false } = {}) {
  try {
    const hostHeader = String((fromTrustedProxy(req, trustProxy) && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
    if (!hostHeader || hostHeader.length > 255) return false;
    const hostname = hostnameOf(hostHeader);
    if (!hostname) return false;
    const local = hostname === 'localhost' || isIP(hostname) > 0;
    if (!local && !hostMatches(hostname, allowedHosts)) return false;
    const origin = req.headers.origin;
    if (origin) {
      const parsedOrigin = new URL(String(origin));
      if (parsedOrigin.protocol !== requestProtocol(req, { trustProxy }) || parsedOrigin.host.toLowerCase() !== hostHeader.toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validKey(value) {
  return typeof value === 'string' && value.length >= MIN_ACCESS_KEY_LENGTH && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value);
}

// The persistent access key: OASIS_WEB_TOKEN wins, then the saved key file,
// otherwise a new key is created and saved owner-only. `rotate` replaces it.
export function loadAccessKey({ env = process.env, rotate = false, create = true } = {}) {
  if (env.OASIS_WEB_TOKEN !== undefined && env.OASIS_WEB_TOKEN !== '') {
    if (!validKey(env.OASIS_WEB_TOKEN)) throw new Error('OASIS_WEB_TOKEN must be at least ' + MIN_ACCESS_KEY_LENGTH + ' characters of letters, digits, - or _.');
    return { key: env.OASIS_WEB_TOKEN, source: 'env', created: false };
  }
  const dir = getConfigDirectory(env);
  const file = path.join(dir, ACCESS_KEY_FILE);
  if (!rotate && existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (validKey(saved)) return { key: saved, source: 'file', file, created: false };
  }
  if (!create) return null;
  const key = randomBytes(32).toString('base64url');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, key + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  return { key, source: 'file', file, created: true };
}

// Wrong keys are counted per client address. After `max` failures in
// `windowMs` the address waits `lockMs`; a correct key clears its count.
export function createAuthLimiter({ max = 10, windowMs = 60_000, lockMs = 5 * 60_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  function sweep(time) {
    if (entries.size < 1000) return;
    for (const [address, entry] of entries) if (entry.lockedUntil < time && time - entry.first > windowMs) entries.delete(address);
  }
  return {
    blocked(address) {
      const entry = entries.get(address);
      const time = now();
      if (!entry || entry.lockedUntil <= time) return 0;
      return Math.ceil((entry.lockedUntil - time) / 1000);
    },
    fail(address) {
      const time = now();
      sweep(time);
      let entry = entries.get(address);
      if (!entry || time - entry.first > windowMs) entry = { first: time, count: 0, lockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= max) { entry.lockedUntil = time + lockMs; entry.count = 0; entry.first = time; }
      entries.set(address, entry);
      return entry.lockedUntil > time ? Math.ceil(lockMs / 1000) : 0;
    },
    succeed(address) { entries.delete(address); },
    get size() { return entries.size; }
  };
}
