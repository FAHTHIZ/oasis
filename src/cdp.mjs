// Minimal Chrome DevTools Protocol client with no dependencies: finds and launches
// Chrome/Chromium/Edge with --remote-debugging-port, and speaks CDP over a small
// RFC 6455 WebSocket client (Node 20 has no global WebSocket without a flag).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';

export function findChrome(env = process.env, platform = process.platform) {
  const explicit = env.OASIS_CHROME_PATH || env.CHROME_PATH;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else {
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) candidates.push(path.join(dir, name));
    }
  }
  // Playwright's browser cache is a common place to already have Chromium.
  const cache = env.PLAYWRIGHT_BROWSERS_PATH || (platform === 'darwin' ? path.join(env.HOME || os.homedir(), 'Library', 'Caches', 'ms-playwright') : platform === 'win32' ? path.join(env.LOCALAPPDATA || '', 'ms-playwright') : path.join(env.HOME || os.homedir(), '.cache', 'ms-playwright'));
  try {
    const dirs = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse();
    for (const dir of dirs) {
      if (platform === 'linux') candidates.push(path.join(cache, dir, 'chrome-linux', 'chrome'), path.join(cache, dir, 'chrome-linux64', 'chrome'));
      if (platform === 'darwin') candidates.push(path.join(cache, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
      if (platform === 'win32') candidates.push(path.join(cache, dir, 'chrome-win', 'chrome.exe'));
    }
  } catch {}
  return candidates.find((file) => { try { return existsSync(file); } catch { return false; } }) || null;
}

function getJson(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('DevTools HTTP timeout')));
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// --- WebSocket (client side, text frames only, masked as the RFC requires) ---
class WsClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', () => { if (this.onclose) this.onclose(); });
    socket.on('error', () => {});
  }
  static connect(url) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
      req.on('upgrade', (res, socket, head) => {
        const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (res.headers['sec-websocket-accept'] !== expected) { socket.destroy(); reject(new Error('Bad WebSocket handshake')); return; }
        const client = new WsClient(socket);
        if (head && head.length) client.feed(head);
        resolve(client);
      });
      req.on('response', (res) => reject(new Error('WebSocket upgrade refused: HTTP ' + res.statusCode)));
      req.on('error', reject);
      req.end();
    });
  }
  send(text) {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    const header = len < 126 ? Buffer.from([0x81, 0x80 | len]) : len < 65536 ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    const mask = crypto.randomBytes(4);
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, payload]));
  }
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + len) return;
      let payload = this.buffer.subarray(offset + maskBytes, offset + maskBytes + len);
      if (masked) { const mask = this.buffer.subarray(offset, offset + 4); payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3])); }
      this.buffer = this.buffer.subarray(offset + maskBytes + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); continue; }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.fragments.push(Buffer.from(payload));
        if (fin) { const text = Buffer.concat(this.fragments).toString('utf8'); this.fragments = []; if (this.onmessage) this.onmessage(text); }
      }
    }
  }
  close() { try { this.socket.end(Buffer.from([0x88, 0x80, 0, 0, 0, 0])); } catch {} try { this.socket.destroy(); } catch {} }
}

/** One CDP connection to a page target. */
export class CdpPage {
  constructor(ws, target) {
    this.ws = ws;
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.onmessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error')); else resolve(msg.result || {});
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) { try { fn(msg.params || {}); } catch {} }
      }
    };
    ws.onclose = () => { this.closed = true; for (const { reject } of this.pending.values()) reject(new Error('Browser tab closed')); this.pending.clear(); };
  }
  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('Browser tab closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  once(method, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const list = this.listeners.get(method) || [];
      const fn = (params) => { clearTimeout(timer); const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); resolve(params); };
      list.push(fn);
      this.listeners.set(method, list);
    });
  }
  close() { this.closed = true; this.ws.close(); }
}

/** A launched (or attached) browser. */
export class Browser {
  constructor({ port, child = null, profile = null }) { this.port = port; this.child = child; this.profile = profile; }
  static async launch({ env = process.env, headless = true, executable = null, timeoutMs = 45000 } = {}) {
    const exe = executable || findChrome(env);
    if (!exe) throw new Error('No Chrome, Chromium or Edge found. Install one, or set OASIS_CHROME_PATH to its executable.');
    const port = await freePort();
    const profile = await mkdtemp(path.join(os.tmpdir(), 'oasis-chrome-'));
    const args = ['--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--window-size=1280,900'];
    // GitHub-hosted Linux runners and small-memory containers can have a tiny
    // /dev/shm. Chrome otherwise may start slowly or fail before opening CDP.
    if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
    if (headless) args.push('--disable-gpu', '--disable-extensions', '--disable-default-apps');
    if (headless) args.push('--headless=new');
    if (process.platform === 'linux' && (env.OASIS_CHROME_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0))) args.push('--no-sandbox');
    args.push('about:blank');
    const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], ...processTreeSpawnOptions() });
    let spawnError = null;
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', (error) => { spawnError = error; });
    const browser = new Browser({ port, child, profile });
    const started = Date.now();
    for (;;) {
      try { await getJson(port, '/json/version'); break; } catch {}
      if (spawnError) {
        await browser.close();
        throw new Error('Could not start Chrome: ' + spawnError.message + (stderr ? '\n' + stderr : ''));
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const status = child.signalCode ? 'signal ' + child.signalCode : 'code ' + child.exitCode;
        await browser.close();
        throw new Error('Chrome exited during startup (' + status + ').' + (stderr ? '\n' + stderr : ''));
      }
      if (Date.now() - started > Math.max(1000, Math.min(Number(timeoutMs) || 45000, 90000))) {
        await browser.close();
        throw new Error('Chrome did not open its DevTools port in time.' + (stderr ? '\n' + stderr : ''));
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return browser;
  }
  /** Attach to a Chrome you started with --remote-debugging-port. */
  static async attach(port) { await getJson(port, '/json/version'); return new Browser({ port }); }
  async pages() { return (await getJson(this.port, '/json/list')).filter((t) => t.type === 'page'); }
  async newPage(url = 'about:blank') {
    let target;
    try { target = await getJson(this.port, '/json/new?' + encodeURIComponent(url), 'PUT'); }
    catch { target = await getJson(this.port, '/json/new?' + encodeURIComponent(url)); }
    return this.connect(target);
  }
  async connect(target) { return new CdpPage(await WsClient.connect(target.webSocketDebuggerUrl), target); }
  async closePage(id) { try { await getJson(this.port, '/json/close/' + id); } catch {} }
  async close() {
    const child = this.child;
    if (child && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.removeListener('exit', onExit);
          child.removeListener('error', onExit);
          resolve(value);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), 2500);
        timer.unref?.();
        child.once('exit', onExit);
        child.once('error', onExit);
      });
      signalProcessTree(child, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
      if (process.platform !== 'win32') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        signalProcessTree(child, 'SIGKILL');
      }
      await exited;
    }
    if (this.profile) await rm(this.profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
