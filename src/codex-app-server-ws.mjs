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
// Auth: `--ws-auth capability-token` with `--ws-token-file PATH` or
// `--ws-token-sha256 HEX`. Clients send `Authorization: Bearer TOKEN` in the
// handshake; the check happens before any JSON-RPC message is read. Unlike
// Codex (which allows unauthenticated non-loopback listeners during its
// rollout), OASIS refuses to listen beyond loopback without auth.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createCodexAppServer } from './codex-app-server.mjs';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function parseListenUrl(value) {
  const text = String(value || '').trim();
  if (!text || text === 'stdio' || text === 'stdio://') return { transport: 'stdio' };
  let url;
  try { url = new URL(text); } catch { throw new Error('--listen must be stdio:// or ws://IP:PORT, got ' + text + '.'); }
  if (url.protocol !== 'ws:') throw new Error('--listen supports stdio:// and ws://IP:PORT (put TLS in front with a proxy for wss).');
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

// Resolve --ws-auth flags into a verifier. Returns null for no auth.
export async function loadWsAuth({ mode, tokenFile, tokenSha256 } = {}) {
  if (!mode) {
    if (tokenFile || tokenSha256) throw new Error('--ws-token-file and --ws-token-sha256 need --ws-auth capability-token.');
    return null;
  }
  if (mode === 'signed-bearer-token') throw new Error('--ws-auth signed-bearer-token is not supported by OASIS yet; use --ws-auth capability-token.');
  if (mode !== 'capability-token') throw new Error('--ws-auth must be capability-token.');
  if (Boolean(tokenFile) === Boolean(tokenSha256)) throw new Error('--ws-auth capability-token needs exactly one of --ws-token-file PATH or --ws-token-sha256 HEX.');
  let digest;
  if (tokenFile) {
    if (!path.isAbsolute(tokenFile)) throw new Error('--ws-token-file must be an absolute path.');
    const info = await stat(tokenFile).catch(() => null);
    if (!info || !info.isFile()) throw new Error('--ws-token-file ' + tokenFile + ' is not a readable file.');
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('--ws-token-file ' + tokenFile + ' is readable by other users; run chmod 600 on it.');
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token.length < 16) throw new Error('The token in --ws-token-file must be at least 16 characters.');
    digest = sha256(token);
  } else {
    if (!/^[0-9a-f]{64}$/i.test(String(tokenSha256))) throw new Error('--ws-token-sha256 must be 64 hex characters (the SHA-256 of the token).');
    digest = Buffer.from(String(tokenSha256), 'hex');
  }
  return (header) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ''));
    if (!m) return false;
    return timingSafeEqual(sha256(m[1]), digest);
  };
}

export async function startCodexAppServerWebSocket(options = {}) {
  const { host = '127.0.0.1', port = 0, verify = null } = options;
  if (!verify && !isLoopbackHost(host)) throw new Error('Listening on ' + host + ' without auth would let anyone on the network run commands. Use --ws-auth capability-token --ws-token-file PATH, or listen on 127.0.0.1 and use SSH port forwarding.');
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
  await new Promise((resolve, rejectListen) => {
    http.once('error', rejectListen);
    http.listen(port, host, () => { http.off('error', rejectListen); resolve(); });
  });
  accepting = true;
  const address = http.address();
  return {
    host,
    port: address.port,
    url: 'ws://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + address.port,
    connections,
    async close() {
      accepting = false;
      for (const { ws, server } of connections) { try { ws.close(1001, 'server shutting down'); } catch {} await server.close().catch(() => {}); }
      connections.clear();
      await new Promise((resolve) => { wss.close(() => resolve()); });
      await new Promise((resolve) => http.close(() => resolve()));
    }
  };
}
