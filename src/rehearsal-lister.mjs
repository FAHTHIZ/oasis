// Runs inside the rehearsal sandbox (see rehearsal.mjs): starts the command,
// waits for it, then lists the merged contents of every directory present in
// the overlay's upper layer, so the host can tell which lower entries an
// opaque (replaced) directory dropped without reading overlay xattrs.
//
// argv: upper lower reportFile -- command args...
//
// With OASIS_REHEARSAL_RECORD_NET=1 (network off), it also listens on loopback as an
// HTTP proxy and points the usual proxy variables at it. Every request is refused with
// 403 and nothing leaves the sandbox; the host and port each one asked for are
// recorded, so the person sees which servers the command would contact.
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [upper, lower, report, separator, command, ...args] = process.argv.slice(2);
if (separator !== '--' || !command) process.exit(2);
const MAX_HOSTS = 20;
const contacts = new Map();
const record = (host, port, how) => {
  const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!/^[a-z0-9.:_-]{1,253}$/.test(name)) return;
  const key = name + ':' + (Number(port) || 0);
  if (contacts.has(key) || contacts.size >= MAX_HOSTS) return;
  contacts.set(key, { host: name, port: Number(port) || 0, via: how });
};
const REFUSAL = 'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: 47\r\n\r\nOASIS rehearsal: the network is off, not sent.\n';
function startRecorder() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let head = '';
      socket.setTimeout(5000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        head += chunk.toString('latin1');
        if (head.length > 16384) { socket.destroy(); return; }
        const end = head.indexOf('\r\n');
        if (end < 0) return;
        const [method, target] = head.slice(0, end).split(' ');
        if (method === 'CONNECT') {
          const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target || '');
          if (match) record(match[1], match[2], 'https');
        } else {
          try { const url = new URL(target); record(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80), url.protocol.replace(':', '')); } catch {}
        }
        socket.end(REFUSAL);
      });
    });
    server.on('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); });
  });
}

const childEnv = { ...process.env };
const recordNet = childEnv.OASIS_REHEARSAL_RECORD_NET === '1';
delete childEnv.OASIS_REHEARSAL_RECORD_NET;
const port = recordNet ? await startRecorder() : null;
if (port) {
  const proxy = 'http://127.0.0.1:' + port;
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) childEnv[name] = proxy;
  // Local servers a test starts stay reachable directly.
  for (const name of ['NO_PROXY', 'no_proxy']) childEnv[name] = 'localhost,127.0.0.1,::1';
  for (const name of ['ALL_PROXY', 'all_proxy']) delete childEnv[name];
  childEnv.NODE_USE_ENV_PROXY = '1';
  childEnv.PIP_PROXY = proxy;
  // A proxy in git's config files outranks the environment; GIT_CONFIG_* outranks both.
  const count = /^\d{1,3}$/.test(String(childEnv.GIT_CONFIG_COUNT || '')) ? Number(childEnv.GIT_CONFIG_COUNT) : 0;
  for (let i = 0; i < count; i++) if (/^http\..+\.proxy$/i.test(String(childEnv['GIT_CONFIG_KEY_' + i] || ''))) childEnv['GIT_CONFIG_VALUE_' + i] = proxy;
  childEnv['GIT_CONFIG_KEY_' + count] = 'http.proxy';
  childEnv['GIT_CONFIG_VALUE_' + count] = proxy;
  childEnv.GIT_CONFIG_COUNT = String(count + 1);
}
const child = spawn(command, args, { stdio: 'inherit', env: childEnv });
const forward = (signal) => { try { child.kill(signal); } catch {} };
process.on('SIGTERM', () => forward('SIGTERM'));
child.on('error', (error) => { process.stderr.write(String(error.message || error) + '\n'); finish(127); });
child.on('exit', (code, signal) => finish(code === null ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code));

let done = false;
function finish(exitCode) {
  if (done) return;
  done = true;
  const dirs = {};
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(rel ? path.join(upper, rel) : upper, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      try { dirs[childRel] = readdirSync(path.join(lower, childRel)); } catch {}
      walk(childRel);
    }
  };
  walk('');
  try { writeFileSync(report, JSON.stringify({ exitCode, dirs, ...(port ? { contacts: [...contacts.values()] } : {}) })); } catch {}
  process.exit(exitCode);
}
