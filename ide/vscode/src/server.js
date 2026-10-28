// OASIS IDE bridge server. Editor-agnostic: the VS Code extension passes an adapter
// that implements the methods below with the editor API, so this file runs (and is
// tested) in plain Node.
//
// Transport: HTTP POST /rpc on 127.0.0.1 with "Authorization: Bearer <token>".
// Discovery: a lock file <oasis config dir>/ide/<port>.lock containing
//   { port, pid, authToken, ideName, workspaceFolders, transport: "http", version }
// written with mode 0600, removed on shutdown. The CLI finds the lock whose workspace
// folder contains its working directory, or the port in OASIS_IDE_PORT.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const METHODS = ['ping', 'getSelection', 'getOpenEditors', 'getWorkspaceFolders', 'getDiagnostics', 'openFile', 'openDiff', 'closeDiffs'];
const MAX_BODY = 4 * 1024 * 1024;

function configDirectory(env = process.env) {
  if (env.OASIS_CONFIG_DIR) return path.resolve(env.OASIS_CONFIG_DIR);
  if (env.OASIS_HOME) return path.resolve(env.OASIS_HOME);
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'oasis');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'oasis');
}

function lockDirectory(env = process.env) { return path.join(configDirectory(env), 'ide'); }

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function startIdeServer(adapter, options = {}) {
  const env = options.env || process.env;
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { error: 'not found' });
    // Browsers cannot set this header cross-origin without a preflight we never answer.
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) return send(401, { error: 'unauthorized' });
    if (req.headers.origin) return send(403, { error: 'browser origins are not allowed' });
    let size = 0; const chunks = [];
    req.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(chunk); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { error: 'invalid JSON' }); }
      const method = String(payload.method || '');
      if (!METHODS.includes(method)) return send(400, { error: 'unknown method ' + method });
      try {
        const result = method === 'ping' ? { ok: true, ideName: adapter.ideName || 'VS Code' } : await adapter[method](payload.params || {});
        send(200, { result: result === undefined ? null : result });
      } catch (error) { send(200, { error: String(error && error.message || error) }); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const dir = lockDirectory(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(dir, port + '.lock');
  const writeLock = () => fs.writeFileSync(lockFile, JSON.stringify({
    port, pid: process.pid, authToken: token, ideName: adapter.ideName || 'VS Code', transport: 'http', version: 1,
    workspaceFolders: (adapter.workspaceFolders ? adapter.workspaceFolders() : []).map((folder) => path.resolve(folder))
  }), { mode: 0o600 });
  writeLock();
  return {
    port, token, lockFile, server,
    refreshLock: writeLock,
    close() { try { fs.unlinkSync(lockFile); } catch {} return new Promise((resolve) => server.close(() => resolve())); }
  };
}

module.exports = { startIdeServer, lockDirectory, configDirectory, METHODS };
