import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bypassesProxy, createProxyFetch, describeProxy, parseProxyUrl, proxyForUrl } from '../src/proxy.mjs';

const proxyModule = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'proxy.mjs');

test('picks the proxy per scheme and honours NO_PROXY', () => {
  const env = { HTTPS_PROXY: 'http://proxy.corp:8080', http_proxy: 'proxy.corp:3128', NO_PROXY: 'internal.corp, .svc.local, *.example.org, 10.0.0.0/8, git.corp:8443' };
  assert.equal(proxyForUrl('https://api.anthropic.com/v1/messages', env).host, 'proxy.corp:8080');
  assert.equal(proxyForUrl('http://example.com/', env).host, 'proxy.corp:3128');
  for (const direct of ['https://internal.corp/x', 'https://a.internal.corp/x', 'https://svc.local/', 'https://db.svc.local/', 'https://api.example.org/', 'http://10.2.3.4/', 'https://git.corp:8443/', 'http://localhost:11434/', 'http://127.0.0.1:8080/', 'http://[::1]:1234/']) {
    assert.equal(proxyForUrl(direct, env), null, direct);
  }
  assert.ok(proxyForUrl('https://git.corp/', env), 'a NO_PROXY port only matches that port');
  assert.ok(proxyForUrl('http://11.0.0.1/', env));
  assert.equal(proxyForUrl('https://x.com/', { ...env, NO_PROXY: '*' }), null);
  assert.equal(proxyForUrl('https://x.com/', { ...env, OASIS_PROXY: '0' }), null);
  assert.equal(proxyForUrl('https://x.com/', {}), null);
  assert.equal(proxyForUrl('https://x.com/', { ALL_PROXY: 'http://all:1' }).host, 'all:1');
  assert.equal(parseProxyUrl('socks5://p:1080'), null, 'SOCKS is not supported, so it is ignored rather than misused');
  assert.equal(describeProxy(parseProxyUrl('http://user:s3cret@proxy:8080')), 'http://***@proxy:8080');
  assert.equal(bypassesProxy(new URL('https://notinternal.corp/'), 'internal.corp'), false);
});

async function startProxy({ requireAuth = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ type: 'request', url: req.url, auth: req.headers['proxy-authorization'] || null });
    if (requireAuth && req.headers['proxy-authorization'] !== requireAuth) { res.writeHead(407); res.end(); return; }
    const target = new URL(req.url);
    const upstream = http.request({ host: '127.0.0.1', port: Number(target.port), path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(upstream);
  });
  server.on('connect', (req, socket) => {
    seen.push({ type: 'connect', url: req.url, auth: req.headers['proxy-authorization'] || null });
    if (requireAuth && req.headers['proxy-authorization'] !== requireAuth) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const port = Number(req.url.split(':').pop());
    const upstream = net.connect(port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.pipe(socket); socket.pipe(upstream); });
    upstream.on('error', () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, url: 'http://127.0.0.1:' + server.address().port };
}

test('http:// requests go through the proxy with credentials; redirects drop Authorization across origins', async (t) => {
  const proxy = await startProxy({ requireAuth: 'Basic ' + Buffer.from('me:p@ss').toString('base64') });
  t.after(() => proxy.server.close());
  const hits = [];
  const target = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    hits.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization || null, method: req.method, body });
    if (req.url === '/start') { res.writeHead(302, { location: 'http://other.test:' + target.address().port + '/end' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const port = target.address().port;
  const env = { HTTP_PROXY: proxy.url.replace('http://', 'http://me:p%40ss@') };
  const proxiedFetch = createProxyFetch({ env, direct: () => { throw new Error('should not connect directly'); } });

  const res = await proxiedFetch('http://api.test:' + port + '/v1/models?x=1', { headers: { authorization: 'Bearer KEY' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, path: '/v1/models?x=1' });
  assert.equal(proxy.seen[0].url, 'http://api.test:' + port + '/v1/models?x=1');
  assert.equal(hits[0].host, 'api.test:' + port);
  assert.equal(hits[0].auth, 'Bearer KEY');

  const redirected = await proxiedFetch('http://api.test:' + port + '/start', { method: 'POST', body: 'payload', headers: { authorization: 'Bearer KEY', 'content-type': 'text/plain' } });
  assert.equal(redirected.status, 200);
  assert.equal(redirected.url, 'http://other.test:' + port + '/end');
  const end = hits.at(-1);
  assert.equal(end.method, 'GET', '302 after POST becomes GET');
  assert.equal(end.body, '');
  assert.equal(end.auth, null, 'credentials are not sent to another origin');
  await assert.rejects(proxiedFetch('http://api.test:' + port + '/start', { redirect: 'error' }), /redirect/);

  const wrong = createProxyFetch({ env: { HTTP_PROXY: proxy.url }, direct: () => { throw new Error('direct'); } });
  assert.equal((await wrong('http://api.test:' + port + '/v1')).status, 407);
});

test('https:// requests tunnel with CONNECT, so the proxy never sees the request or key', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-proxy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=api.example.test', '-addext', 'subjectAltName=DNS:api.example.test'], { stdio: 'ignore' });
  } catch { t.skip('OpenSSL is required for the TLS fixture.'); return; }
  const target = https.createServer({ cert: await readFile(cert), key: await readFile(key) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ host: req.headers.host, auth: req.headers.authorization || null }));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const proxy = await startProxy();
  t.after(() => proxy.server.close());
  const port = target.address().port;
  const script = `
    const { installProxyFromEnv } = await import(${JSON.stringify(proxyModule)});
    console.log('PROXY', installProxyFromEnv());
    const res = await fetch('https://api.example.test:${port}/v1/messages', { method: 'POST', headers: { authorization: 'Bearer SECRET-KEY', 'content-type': 'application/json' }, body: '{}' });
    console.log('RESULT', res.status, await res.text());
    const denied = await fetch('https://api.example.test:1/x').then(() => 'ok', (e) => String(e.cause && e.cause.message || e.message));
    console.log('DENIED', denied);
  `;
  const runChild = (extra) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HTTPS_PROXY: proxy.url, NO_PROXY: '', no_proxy: '', OASIS_PROXY: '', ...extra } });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('error', reject);
    child.on('exit', () => resolve(text));
  });
  const untrusted = await runChild({ NODE_EXTRA_CA_CERTS: '' });
  assert.doesNotMatch(untrusted, /RESULT 200/, 'the target certificate is still verified through the tunnel');
  assert.match(untrusted, /certificate|self.signed/i, untrusted);
  proxy.seen.length = 0;
  const out = await runChild({ NODE_EXTRA_CA_CERTS: cert });
  assert.match(out, /PROXY http:\/\/127\.0\.0\.1:\d+/, out);
  assert.match(out, /RESULT 200 \{"host":"api\.example\.test:\d+","auth":"Bearer SECRET-KEY"\}/, out);
  assert.equal(proxy.seen[0].type, 'connect');
  assert.equal(proxy.seen[0].url, 'api.example.test:' + port);
  assert.ok(proxy.seen.every((entry) => entry.type === 'connect'), 'nothing was sent to the proxy in plain text');
  assert.match(out, /DENIED .+/, out);
});

test('local model servers keep the no-hidden-timeout client when the proxy is installed', async () => {
  const { providerFetch, loopbackFetch, OASIS_FETCH } = await import('../src/loopback-fetch.mjs');
  const original = globalThis.fetch;
  try {
    const marked = Object.assign(() => {}, { [OASIS_FETCH]: true });
    globalThis.fetch = marked;
    assert.equal(providerFetch(true), loopbackFetch);
    assert.equal(providerFetch(false), marked);
    const stub = () => {};
    globalThis.fetch = stub;
    assert.equal(providerFetch(true), stub, 'test stubs still win');
  } finally {
    globalThis.fetch = original;
  }
});

test('the fetch_url tool goes through the proxy but only to the address that passed the private-network check', async (t) => {
  const { fetchPublicUrl } = await import('../src/public-fetch.mjs');
  const proxy = await startProxy();
  t.after(() => proxy.server.close());
  const target = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('docs for ' + req.headers.host); });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const port = target.address().port;
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
  const result = await fetchPublicUrl('http://docs.example.com:' + port + '/guide', { lookupImpl, env: { HTTP_PROXY: proxy.url } });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.content, 'docs for docs.example.com:' + port);
  assert.deepEqual([proxy.seen[0].type, proxy.seen[0].url], ['connect', '93.184.216.34:' + port], 'the proxy is given the vetted IP, not the host name');
  await assert.rejects(fetchPublicUrl('http://evil.example.com/', { lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }], env: { HTTP_PROXY: proxy.url } }).then((r) => { if (r.error) throw new Error(r.error); return r; }), /private|blocked/i);
  assert.equal(proxy.seen.length, 1, 'a blocked address never reaches the proxy');
});
