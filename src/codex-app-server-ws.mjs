// WebSocket transport for the Codex App Server protocol
// (https://learn.chatgpt.com/docs/app-server): `oasis app-server --listen
// ws://IP:PORT`. One JSON-RPC message per text frame; each connection gets its
// own protocol state (initialize, threads, approvals), like a stdio process.
//
// The same listener answers HTTP health probes: GET /readyz (200 once
// accepting), GET /healthz (200 unless the request carries an Origin header).
// Any request with an Origin header, including a WebSocket upgrade, gets 403,
// so a web page in a browser cannot reach the server.
//
// Unix socket: `--listen unix://` (default path
// <config dir>/app-server-control/app-server-control.sock) or
// `--listen unix://PATH` serves the same WebSocket protocol over a Unix domain
// socket, as Codex does. The folder is created 0700 and the socket chmod 0600,
// so only this user can connect; no token is needed. A stale socket left by a
// crashed server is removed; a live one or a non-socket file is an error.
//
// Auth: `--ws-auth capability-token` with `--ws-token-file PATH` or
// `--ws-token-sha256 HEX`. Clients send `Authorization: Bearer TOKEN` in the
// handshake; the check happens before any JSON-RPC message is read.
// `--ws-auth signed-bearer-token --ws-shared-secret-file PATH` instead accepts
// an HS256 JWT signed with the shared secret (at least 32 bytes), as Codex
// does: `exp` is required, `nbf` is honoured, `--ws-issuer` and
// `--ws-audience` pin `iss` and `aud`, and `--ws-max-clock-skew-seconds`
// (default 30) allows for clock drift. Unlike
// Codex (which allows unauthenticated non-loopback listeners during its
// rollout), OASIS refuses to listen beyond loopback without auth.
import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createCodexAppServer } from './codex-app-server.mjs';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const CONTROL_SOCKET_DIR = 'app-server-control';
const CONTROL_SOCKET_FILE = 'app-server-control.sock';

export function defaultControlSocketPath(env = process.env) {
  const home = env.OASIS_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || '', '.oasis');
  return path.join(home, CONTROL_SOCKET_DIR, CONTROL_SOCKET_FILE);
}

export function parseListenUrl(value, { env = process.env, cwd = process.cwd() } = {}) {
  const text = String(value || '').trim();
  if (!text || text === 'stdio' || text === 'stdio://') return { transport: 'stdio' };
  if (text.startsWith('unix://')) {
    if (process.platform === 'win32') throw new Error('--listen unix:// is not supported on Windows by OASIS; use ws://127.0.0.1:PORT.');
    const raw = text.slice('unix://'.length);
    const socketPath = raw ? path.resolve(cwd, raw) : defaultControlSocketPath(env);
    // Linux sun_path is 108 bytes including the terminator; macOS is 104.
    if (Buffer.byteLength(socketPath) > 103) throw new Error('Unix socket path is too long (' + Buffer.byteLength(socketPath) + ' bytes, at most 103): ' + socketPath);
    return { transport: 'unix', socketPath, defaultPath: !raw };
  }
  let url;
  try { url = new URL(text); } catch { throw new Error('--listen must be stdio://, unix://[PATH] or ws://IP:PORT, got ' + text + '.'); }
  if (url.protocol !== 'ws:') throw new Error('--listen supports stdio://, unix://[PATH] and ws://IP:PORT (put TLS in front with a proxy for wss).');
  if (url.pathname && url.pathname !== '/') throw new Error('--listen takes ws://IP:PORT with no path.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port === '' ? NaN : Number(url.port);
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--listen needs a host and port, for example ws://127.0.0.1:4500.');
  return { transport: 'ws', host, port };
}

export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest();

const bearerToken = (header) => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ''));
  return m ? m[1] : null;
};

async function readSecretFile(flagName, file, minLength, unit) {
  if (!path.isAbsolute(file)) throw new Error(flagName + ' must be an absolute path.');
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) throw new Error(flagName + ' ' + file + ' is not a readable file.');
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error(flagName + ' ' + file + ' is readable by other users; run chmod 600 on it.');
  const secret = (await readFile(file, 'utf8')).trim();
  const size = unit === 'bytes' ? Buffer.byteLength(secret, 'utf8') : secret.length;
  if (size < minLength) throw new Error('The secret in ' + flagName + ' must be at least ' + minLength + ' ' + unit + '.');
  return secret;
}

const base64UrlJson = (part) => {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
};

// Check an HS256 JWT the way Codex's websocket-auth crate does. Returns null
// when the token is good, or the reason it was refused.
export function checkSignedBearerToken(token, { secret, issuer = null, audience = null, maxClockSkewSeconds = 30, now = Math.floor(Date.now() / 1000) } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return 'invalid websocket jwt';
  const header = base64UrlJson(parts[0]);
  const claims = base64UrlJson(parts[1]);
  if (!header || header.alg !== 'HS256' || !claims || typeof claims !== 'object' || Array.isArray(claims)) return 'invalid websocket jwt';
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) return 'invalid websocket jwt';
  const expected = createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return 'invalid websocket jwt';
  if (!Number.isInteger(claims.exp)) return 'invalid websocket jwt';
  if (claims.nbf !== undefined && claims.nbf !== null && !Number.isInteger(claims.nbf)) return 'invalid websocket jwt';
  if (now > claims.exp + maxClockSkewSeconds) return 'expired websocket jwt';
  if (Number.isInteger(claims.nbf) && now < claims.nbf - maxClockSkewSeconds) return 'websocket jwt is not valid yet';
  if (issuer && claims.iss !== issuer) return 'websocket jwt issuer mismatch';
  if (audience) {
    const aud = claims.aud;
    const ok = typeof aud === 'string' ? aud === audience : Array.isArray(aud) && aud.includes(audience);
    if (!ok) return 'websocket jwt audience mismatch';
  }
  return null;
}

// Resolve --ws-auth flags into a verifier. Returns null for no auth.
export async function loadWsAuth({ mode, tokenFile, tokenSha256, sharedSecretFile, issuer, audience, maxClockSkewSeconds } = {}) {
  const signedFlags = Boolean(sharedSecretFile || issuer || audience || (maxClockSkewSeconds !== undefined && maxClockSkewSeconds !== null));
  if (!mode) {
    if (tokenFile || tokenSha256) throw new Error('--ws-token-file and --ws-token-sha256 need --ws-auth capability-token.');
    if (signedFlags) throw new Error('--ws-shared-secret-file, --ws-issuer, --ws-audience and --ws-max-clock-skew-seconds need --ws-auth signed-bearer-token.');
    return null;
  }
  if (mode === 'signed-bearer-token') {
    if (tokenFile || tokenSha256) throw new Error('--ws-token-file and --ws-token-sha256 need --ws-auth capability-token, not signed-bearer-token.');
    if (!sharedSecretFile) throw new Error('--ws-auth signed-bearer-token needs --ws-shared-secret-file PATH.');
    let skew = 30;
    if (maxClockSkewSeconds !== undefined && maxClockSkewSeconds !== null) {
      skew = Number(maxClockSkewSeconds);
      if (!Number.isSafeInteger(skew) || skew < 0 || !/^\d+$/.test(String(maxClockSkewSeconds).trim())) throw new Error('--ws-max-clock-skew-seconds must be a whole number of seconds.');
    }
    const secret = await readSecretFile('--ws-shared-secret-file', sharedSecretFile, 32, 'bytes');
    const settings = { secret: Buffer.from(secret, 'utf8'), issuer: String(issuer || '').trim() || null, audience: String(audience || '').trim() || null, maxClockSkewSeconds: skew };
    return (header) => {
      const token = bearerToken(header);
      return token !== null && checkSignedBearerToken(token, settings) === null;
    };
  }
  if (mode !== 'capability-token') throw new Error('--ws-auth must be capability-token or signed-bearer-token.');
  if (signedFlags) throw new Error('--ws-shared-secret-file, --ws-issuer, --ws-audience and --ws-max-clock-skew-seconds need --ws-auth signed-bearer-token.');
  if (Boolean(tokenFile) === Boolean(tokenSha256)) throw new Error('--ws-auth capability-token needs exactly one of --ws-token-file PATH or --ws-token-sha256 HEX.');
  let digest;
  if (tokenFile) {
    digest = sha256(await readSecretFile('--ws-token-file', tokenFile, 16, 'characters'));
  } else {
    if (!/^[0-9a-f]{64}$/i.test(String(tokenSha256))) throw new Error('--ws-token-sha256 must be 64 hex characters (the SHA-256 of the token).');
    digest = Buffer.from(String(tokenSha256), 'hex');
  }
  return (header) => {
    const token = bearerToken(header);
    return token !== null && timingSafeEqual(sha256(token), digest);
  };
}

// Make the socket path usable: a private parent folder (when OASIS created it
// or it is the default folder), and no live server or foreign file in the way.
async function prepareSocketPath(socketPath, { privateDir = true } = {}) {
  const dir = path.dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (privateDir) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Socket folder is not a plain directory: ' + dir);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Socket folder belongs to another user: ' + dir);
    if (info.mode & 0o077) await chmod(dir, 0o700);
  }
  let existing;
  try { existing = await lstat(socketPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!existing.isSocket()) throw new Error('App Server socket path exists and is not a socket: ' + socketPath);
  const live = await new Promise((resolve) => {
    const probe = netConnect(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  if (live) throw new Error('An App Server is already listening on ' + socketPath + '.');
  await unlink(socketPath);
}

export async function startCodexAppServerWebSocket(options = {}) {
  const { host = '127.0.0.1', port = 0, verify = null, socketPath = null } = options;
  if (!socketPath && !verify && !isLoopbackHost(host)) throw new Error('Listening on ' + host + ' without auth would let anyone on the network run commands. Use --ws-auth capability-token --ws-token-file PATH (or --ws-auth signed-bearer-token --ws-shared-secret-file PATH), or listen on 127.0.0.1 and use SSH port forwarding.');
  const log = options.log || ((text) => process.stderr.write('[oasis app-server] ' + text + '\n'));
  const connections = new Set();
  let accepting = false;
  const http = createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (req.headers.origin) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('Forbidden\n'); return; }
    if (req.method === 'GET' && pathname === '/readyz') { res.writeHead(accepting ? 200 : 503, { 'content-type': 'text/plain' }); res.end(accepting ? 'OK\n' : 'Starting\n'); return; }
    if (req.method === 'GET' && pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('OK\n'); return; }
    res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket' }); res.end('Use a WebSocket connection.\n');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const reject = (socket, status, text) => {
    socket.write('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ' + (text.length + 1) + '\r\n\r\n' + text + '\n');
    socket.destroy();
  };
  http.on('upgrade', (req, socket, head) => {
    if (req.headers.origin) return reject(socket, 403, 'Forbidden');
    if (verify && !verify(req.headers.authorization)) return reject(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    const server = createCodexAppServer({ ...options, log, write: (line) => { if (ws.readyState === ws.OPEN) ws.send(String(line).replace(/\n$/, '')); } });
    const entry = { ws, server };
    connections.add(entry);
    ws.on('message', (data, isBinary) => {
      if (isBinary) { ws.close(1003, 'text frames only'); return; }
      const text = data.toString('utf8');
      if (!text.trim()) return;
      server.receive(text).catch((error) => log(error.message));
    });
    ws.on('close', () => { connections.delete(entry); server.close().catch(() => {}); });
    ws.on('error', () => {});
  });
  if (socketPath) await prepareSocketPath(socketPath, { privateDir: options.privateDir !== false });
  await new Promise((resolve, rejectListen) => {
    http.once('error', rejectListen);
    const done = () => { http.off('error', rejectListen); resolve(); };
    if (socketPath) http.listen(socketPath, done); else http.listen(port, host, done);
  });
  if (socketPath) await chmod(socketPath, 0o600);
  accepting = true;
  const address = http.address();
  return {
    host: socketPath ? null : host,
    port: socketPath ? null : address.port,
    socketPath,
    url: socketPath ? 'unix://' + socketPath : 'ws://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + address.port,
    connections,
    async close() {
      accepting = false;
      for (const { ws, server } of connections) { try { ws.close(1001, 'server shutting down'); } catch {} await server.close().catch(() => {}); }
      connections.clear();
      await new Promise((resolve) => { wss.close(() => resolve()); });
      await new Promise((resolve) => http.close(() => resolve()));
      if (socketPath) await unlink(socketPath).catch(() => {});
    }
  };
}
