import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkTarget, explainNetworkError, formatNetworkReport, networkTargets } from '../src/network-doctor.mjs';

test('targets are reduced to origins and deduplicated', () => {
  const targets = networkTargets({ config: { protocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1' }, mcpServers: [{ name: 'docs', url: 'https://mcp.example.com/mcp?token=SECRET' }, { name: 'local', command: 'x' }] });
  assert.deepEqual(targets.map((t) => t.url), ['https://api.anthropic.com/', 'https://mcp.example.com/', 'https://api.github.com/']);
  assert.ok(!JSON.stringify(targets).includes('SECRET'));
  assert.equal(networkTargets({ config: { protocol: 'bedrock', region: 'eu-west-1' }, includeGitHub: false })[0].url, 'https://bedrock-runtime.eu-west-1.amazonaws.com/');
});

test('failures are explained in plain terms', () => {
  const wrap = (code, message = code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
  assert.equal(explainNetworkError(wrap('ENOTFOUND')).kind, 'dns');
  assert.equal(explainNetworkError(wrap('ECONNREFUSED')).kind, 'refused');
  const cert = explainNetworkError(wrap('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'));
  assert.equal(cert.kind, 'certificate');
  assert.match(cert.detail, /NODE_EXTRA_CA_CERTS/);
  assert.match(explainNetworkError(wrap('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate')).detail, /intermediate certificate/);
  assert.match(explainNetworkError(wrap('CERT_HAS_EXPIRED', 'certificate has expired')).detail, /expired.*date on this computer/);
  assert.match(explainNetworkError(wrap('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames")).detail, /does not match the host name/);
  assert.match(explainNetworkError(wrap('CERT_NOT_YET_VALID', 'certificate is not yet valid')).detail, /not valid yet/);
  assert.equal(explainNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind, 'timeout');
  assert.equal(explainNetworkError(new Error('The proxy refused to connect to x:443: HTTP/1.1 407 Proxy Authentication Required')).kind, 'proxy-auth');
});

test('a bare request with no credentials proves reachability; 401 counts as reachable', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(401); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const ok = await checkTarget({ label: 'Model provider', url: 'http://127.0.0.1:' + server.address().port + '/' }, { env: {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 401);
  assert.equal(seen[0].authorization, undefined);
  const dns = await checkTarget({ label: 'X', url: 'https://no-such-host.invalid/' }, { env: {}, lookupImpl: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); } });
  assert.equal(dns.ok, false);
  assert.equal(dns.kind, 'dns');
  const viaProxy = await checkTarget({ label: 'X', url: 'https://api.example.com/' }, { env: { HTTPS_PROXY: 'http://user:pw@proxy:3128' }, fetchImpl: async () => new Response(null, { status: 407 }) });
  assert.equal(viaProxy.kind, 'proxy-auth');
  assert.match(viaProxy.route, /via proxy http:\/\/\*\*\*@proxy:3128/);
  const report = formatNetworkReport([ok, dns, viaProxy], { HTTPS_PROXY: 'http://user:pw@proxy:3128' });
  assert.match(report, /OK   Model provider/);
  assert.match(report, /FAIL X/);
  assert.ok(!report.includes('pw@'), 'proxy credentials are never printed');
});

test('a model request that cannot connect says why (refused, untrusted certificate) and points to doctor --network', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const https = await import('node:https');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { testProviderConnection } = await import('../src/agent.mjs');
  const net = await import('node:net');
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const config = (baseURL) => ({ protocol: 'openai-compatible', baseURL, model: 'test-model', apiKey: 'sk-test-network-key-123456' });
  await assert.rejects(testProviderConnection(config('https://127.0.0.1:' + closedPort + '/v1')), /Could not reach the model provider: The connection was refused.*oasis doctor --network/);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-tlsfail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  } catch { t.diagnostic('openssl unavailable; certificate case skipped'); return; }
  const server = https.createServer({ cert: await readFile(path.join(dir, 'c.pem')), key: await readFile(path.join(dir, 'k.pem')) }, (req, res) => res.end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(testProviderConnection(config('https://127.0.0.1:' + server.address().port + '/v1')), /server certificate is not trusted \(DEPTH_ZERO_SELF_SIGNED_CERT\).*NODE_EXTRA_CA_CERTS/);
});
