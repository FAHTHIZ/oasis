// Chrome DevTools Protocol client for the built-in browser tool.
//
// One WebSocket per browser, at the browser-level endpoint, with one flattened
// session per tab (Target.attachToTarget { flatten: true }), the same model
// Puppeteer and Playwright use. It works unchanged against Chrome, Chromium,
// Edge and Obscura; the older per-page sockets (/json/new, /devtools/page/<id>)
// do not exist in every engine and raced with tab creation.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) req.destroy(new Error('DevTools HTTP reply too large')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('DevTools HTTP timeout')));
    req.end();
  });
}

async function readDevToolsPort(profile) {
  try {
    const port = Number(String(await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
  } catch { return 0; }
}

async function readObscuraReady(file) {
  try {
    const ready = JSON.parse(await readFile(file, 'utf8'));
    const port = Number(ready && ready.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
  } catch { return 0; }
}

// The browser endpoint is always dialled on 127.0.0.1 with the port we started or
// were told about. The host in /json/version is not trusted: an attached browser
// (or anything answering on that port) could point it somewhere else.
export function browserWebSocketUrl(port, version) {
  let pathname = '/devtools/browser';
  try {
    const reported = new URL(String(version && version.webSocketDebuggerUrl || ''));
    if (/^\/devtools\/browser(\/[\w-]+)?$/.test(reported.pathname)) pathname = reported.pathname;
  } catch {}
  return 'ws://127.0.0.1:' + port + pathname;
}

let wsModule = null;
async function webSocketImpl() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  if (!wsModule) wsModule = (await import('ws')).default;
  return wsModule;
}

// A small adapter over the WHATWG WebSocket in Node 22+ (or the `ws` package, which
// has the same event API) so the connection below sees onmessage(text)/onclose().
export async function connectWebSocket(url, WebSocketImpl = null) {
  const Impl = WebSocketImpl || await webSocketImpl();
  return new Promise((resolve, reject) => {
    let opened = false;
    const socket = new Impl(url, ...(Impl === wsModule ? [{ maxPayload: 256 * 1024 * 1024 }] : []));
    socket.binaryType = 'arraybuffer';
    const client = {
      onmessage: null,
      onclose: null,
      send: (text) => socket.send(text),
      close: () => { try { socket.close(); } catch {} }
    };
    socket.addEventListener('open', () => { opened = true; resolve(client); });
    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      if (client.onmessage) client.onmessage(text);
    });
    socket.addEventListener('error', (event) => { if (!opened) reject(new Error('WebSocket connection failed: ' + (event.message || (event.error && event.error.message) || url))); });
    socket.addEventListener('close', () => { if (!opened) reject(new Error('WebSocket closed before opening: ' + url)); else if (client.onclose) client.onclose(); });
  });
}

/** The browser-level protocol connection: requests by id, events routed by sessionId. */
export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.onmessage = (text) => this.receive(text);
    ws.onclose = () => this.shutdown();
  }
  receive(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error((msg.error.message || 'CDP error') + (method ? ' (' + method + ')' : ''))); else resolve(msg.result || {});
      return;
    }
    if (!msg.method) return;
    if (msg.method === 'Target.detachedFromTarget' && msg.params && msg.params.sessionId) {
      const session = this.sessions.get(msg.params.sessionId);
      if (session) session.markClosed();
    }
    if (msg.sessionId) {
      const session = this.sessions.get(msg.sessionId) || this.rescueSession(msg);
      if (session) session.emit(msg.method, msg.params || {}, text);
      return;
    }
    for (const fn of this.listeners.get(msg.method) || []) { try { fn(msg.params || {}); } catch {} }
  }
  send(method, params = {}, sessionId = null, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  // Obscura tags some events (paused requests, navigation and lifecycle events)
  // with the target's default session instead of the session we attached, e.g.
  // "page-1-session" for "page-1-session-1". A paused request left unanswered
  // stalls the page, and a missed frameNavigated leaves the tab URL stale, so hand
  // those events to the attached session for the same target. Events that arrive
  // on both sessions are delivered once (CdpPage drops exact repeats).
  rescueSession(msg) {
    const id = String(msg.sessionId);
    for (const session of this.sessions.values()) {
      const target = String(session.target.id || '');
      if (session.sessionId.startsWith(id + '-') || (target && id.startsWith(target + '-'))) return session;
    }
    return null;
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error('Browser connection closed'));
    this.pending.clear();
    for (const session of this.sessions.values()) session.markClosed();
    this.sessions.clear();
  }
  close() { this.shutdown(); try { this.ws.close(); } catch {} }
}

function digest(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + ':' + text.length;
}

/** One tab: a flattened protocol session on the browser connection. */
export class CdpPage {
  constructor(connection, sessionId, target) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.target = { ...target, id: target.targetId || target.id };
    this.listeners = new Map();
    this.waiters = new Set();
    this.seen = new Set();
    this.closed = false;
    connection.sessions.set(sessionId, this);
  }
  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('Browser tab closed'));
    // A command in flight when the tab closes rejects at once, not at its timeout.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Browser tab closed'));
      this.waiters.add(abort);
      this.connection.send(method, params, this.sessionId, timeoutMs).then(resolve, (error) => reject(this.closed ? new Error('Browser tab closed') : error))
        .finally(() => this.waiters.delete(abort));
    });
  }
  emit(method, params, raw = '') {
    if (raw) {
      // The same event on two sessions differs only in its sessionId field.
      const key = method + ' ' + digest(JSON.stringify(params));
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
    }
    for (const fn of [...(this.listeners.get(method) || [])]) { try { fn(params); } catch {} }
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  off(method, fn) { const list = this.listeners.get(method); if (!list) return; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
  once(method, timeoutMs = 15000, predicate = null) {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const settle = (params) => {
        clearTimeout(timer);
        this.waiters.delete(settle);
        this.off(method, fn);
        resolve(params);
      };
      const fn = (params) => { if (!predicate || predicate(params)) settle(params); };
      const timer = setTimeout(() => settle(null), timeoutMs);
      timer.unref?.();
      this.waiters.add(settle);
      this.on(method, fn);
    });
  }
  // Every pending wait settles at once when the tab goes away: a command or event
  // wait must not keep the process (or a caller) waiting for its full timeout.
  markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.connection.sessions.delete(this.sessionId);
    for (const settle of [...this.waiters]) settle(null);
    this.waiters.clear();
  }
  close() {
    if (this.closed) return;
    const { connection, sessionId } = this;
    this.markClosed();
    if (!connection.closed) connection.send('Target.detachFromTarget', { sessionId }, null, 5000).catch(() => {});
  }
}

// Variables that would silently widen what a launched engine may reach.
const ENGINE_ENV_DENY = /^(?:OBSCURA_ALLOW_PRIVATE_NETWORK|OBSCURA_ALLOW_FILE_ACCESS)$/;

function engineEnv(env, headless) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !ENGINE_ENV_DENY.test(key)));
  // A visible browser opens on the display it was given (an agent's own virtual screen).
  if (!headless && env !== process.env && env.DISPLAY) base.DISPLAY = env.DISPLAY;
  return base;
}

/** A launched (or attached) browser. */
export class Browser {
  constructor({ port, child = null, profile = null, keepProfile = false, engine = 'chrome', connection = null, capabilities = {} }) {
    this.port = port;
    this.child = child;
    this.profile = profile;
    this.keepProfile = keepProfile;
    this.engine = engine;
    this.connection = connection;
    this.capabilities = capabilities;
  }

  /**
   * Start a browser. `engine` is 'chrome' or 'obscura'. `profileDir` keeps cookies and
   * storage across launches; without it a private temporary profile is used and removed.
   * For Obscura, `allowPrivateNetwork` and `allowFileAccess` lift the engine's own
   * network boundary; OASIS only sets them after the user approved such a target.
   */
  static async launch({ env = process.env, engine = 'chrome', headless = true, executable = null, timeoutMs = 45000, profileDir = null, allowPrivateNetwork = false, allowFileAccess = false, stealth = false } = {}) {
    const exe = executable || (engine === 'chrome' ? findChrome(env) : null);
    if (!exe) throw new Error(engine === 'chrome' ? 'No Chrome, Chromium or Edge found. Install one, or set OASIS_CHROME_PATH to its executable.' : 'Obscura is not installed. Run `oasis browser install`, or set OASIS_OBSCURA_PATH.');
    let profile = profileDir;
    if (profile) { await mkdir(profile, { recursive: true, mode: 0o700 }); await chmod(profile, 0o700).catch(() => {}); }
    else profile = await mkdtemp(path.join(os.tmpdir(), engine === 'chrome' ? 'oasis-chrome-' : 'oasis-obscura-'));
    let args;
    let readyFile = null;
    if (engine === 'obscura') {
      readyFile = path.join(profile, 'ready-' + process.pid + '-' + Date.now() + '.json');
      args = ['serve', '--host', '127.0.0.1', '--port', '0', '--ready-file', readyFile, '--storage-dir', path.join(profile, 'storage'), '--quiet'];
      if (allowPrivateNetwork) args.push('--allow-private-network');
      if (allowFileAccess) args.push('--allow-file-access');
      if (stealth) args.push('--stealth');
    } else {
      // Port 0 lets Chrome bind its own DevTools port and report it in
      // <profile>/DevToolsActivePort. Picking a "free" port first and handing it
      // over is racy: under parallel load another process (or another Chrome)
      // can take it, and we would end up driving someone else's browser.
      args = ['--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--metrics-recording-only', '--password-store=basic', '--window-size=1280,900'];
      // GitHub-hosted Linux runners and small-memory containers can have a tiny
      // /dev/shm. Chrome otherwise may start slowly or fail before opening CDP.
      if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
      if (headless) args.push('--disable-gpu', '--disable-extensions', '--disable-default-apps', '--headless=new');
      if (process.platform === 'linux' && (env.OASIS_CHROME_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0))) args.push('--no-sandbox');
      args.push('about:blank');
    }
    const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], env: engineEnv(env, headless), ...processTreeSpawnOptions() });
    let spawnError = null;
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', (error) => { spawnError = error; });
    const browser = new Browser({ port: 0, child, profile, keepProfile: Boolean(profileDir), engine, capabilities: { privateNetwork: engine === 'chrome' || allowPrivateNetwork, fileAccess: engine === 'chrome' || allowFileAccess } });
    const name = engine === 'chrome' ? 'Chrome' : 'Obscura';
    const started = Date.now();
    const limit = Math.max(1000, Math.min(Number(timeoutMs) || 45000, 90000));
    try {
      let version = null;
      for (;;) {
        if (!browser.port) browser.port = engine === 'obscura' ? await readObscuraReady(readyFile) : await readDevToolsPort(profile);
        if (browser.port) { try { version = await getJson(browser.port, '/json/version'); break; } catch {} }
        if (spawnError) throw new Error('Could not start ' + name + ': ' + spawnError.message + (stderr ? '\n' + stderr : ''));
        if (child.exitCode !== null || child.signalCode !== null) {
          const status = child.signalCode ? 'signal ' + child.signalCode : 'code ' + child.exitCode;
          throw new Error(name + ' exited during startup (' + status + ').' + (stderr ? '\n' + stderr : ''));
        }
        if (Date.now() - started > limit) throw new Error(name + ' did not open its DevTools port in time.' + (stderr ? '\n' + stderr : ''));
        await new Promise((r) => setTimeout(r, engine === 'obscura' ? 25 : 100));
      }
      browser.connection = new CdpConnection(await connectWebSocket(browserWebSocketUrl(browser.port, version)));
      browser.startupMs = Date.now() - started;
      return browser;
    } catch (error) {
      // A failed start must not leave a browser process (or its profile) behind.
      await browser.close();
      throw error;
    }
  }

  /** Attach to a browser you started with --remote-debugging-port. */
  static async attach(port) {
    const version = await getJson(port, '/json/version');
    const connection = new CdpConnection(await connectWebSocket(browserWebSocketUrl(port, version)));
    return new Browser({ port, connection, engine: /obscura/i.test(String(version && (version.Browser || version['User-Agent']) || '')) ? 'obscura' : 'chrome', capabilities: { privateNetwork: true, fileAccess: true } });
  }

  get closed() { return !this.connection || this.connection.closed; }

  async pages() {
    const { targetInfos = [] } = await this.connection.send('Target.getTargets');
    return targetInfos.filter((t) => t && t.type === 'page').map((t) => ({ ...t, id: t.targetId }));
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.connection.send('Target.createTarget', { url });
    return this.connect({ targetId, url });
  }

  async connect(target) {
    const targetId = target.targetId || target.id;
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true });
    return new CdpPage(this.connection, sessionId, { ...target, targetId });
  }

  async closePage(id) {
    if (this.closed) return;
    await this.connection.send('Target.closeTarget', { targetId: id }, null, 5000).catch(() => {});
  }

  async close() {
    if (this.connection) this.connection.close();
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
        const quick = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), this.engine === 'obscura' ? 300 : 1000))]);
        if (!quick) signalProcessTree(child, 'SIGKILL');
      }
      await exited;
    }
    if (this.profile && !this.keepProfile) await rm(this.profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
