// Regression: choosing OASIS Route in `oasis setup` never asked for the Oasis
// Key and ignored OASIS_ROUTE_API_KEY, because Route listens on loopback and
// the loopback branch skipped the key. The probe then always failed with 401.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function runSetup(home, input, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
    for (const key of Object.keys(env)) if (/^OASIS_(MODEL|BASE_URL|PROTOCOL|LOCAL_API_KEY|API_KEY)$|_API_KEY$/.test(key)) delete env[key];
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI, 'setup'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

async function fakeRoute(t) {
  const seen = { auth: '' };
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    seen.auth = req.headers.authorization || '';
    res.setHeader('content-type', 'application/json');
    if (!seen.auth) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'missing API key' } })); return; }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'oasis_connection_probe', arguments: '{"ready":true}' } }] } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-setup-route-'));
  t.after(async () => { server.close(); await rm(home, { recursive: true, force: true }); });
  return { seen, home, base: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

test('OASIS Route setup uses OASIS_ROUTE_API_KEY from the environment', async (t) => {
  const { seen, home, base } = await fakeRoute(t);
  const { code, out } = await runSetup(home, '1\n5\n\n', { OASIS_PROVIDER_OASIS_ROUTE_BASE_URL: base, OASIS_ROUTE_API_KEY: 'oasis_live_env_key_0123' });
  assert.equal(code, 0, out);
  assert.match(out, /Using the key from OASIS_ROUTE_API_KEY/);
  assert.equal(seen.auth, 'Bearer oasis_live_env_key_0123');
});

test('OASIS Route setup asks for the Oasis Key when none is in the environment', async (t) => {
  const { seen, home, base } = await fakeRoute(t);
  const { code, out } = await runSetup(home, '1\n5\n\noasis_live_pasted_key_0123\n', { OASIS_PROVIDER_OASIS_ROUTE_BASE_URL: base });
  assert.equal(code, 0, out);
  assert.match(out, /OASIS Route key/);
  assert.doesNotMatch(out, /oasis_live_pasted_key/);
  assert.equal(seen.auth, 'Bearer oasis_live_pasted_key_0123');
  const saved = JSON.parse(await readFile(path.join(home, '.config', 'oasis', 'config.json'), 'utf8'));
  assert.equal(saved.model, 'auto');
});

test('OASIS Route is also offered under Advanced provider', async (t) => {
  const { seen, home, base } = await fakeRoute(t);
  const { code, out } = await runSetup(home, '3\n5\n\n', { OASIS_PROVIDER_OASIS_ROUTE_BASE_URL: base, OASIS_ROUTE_API_KEY: 'oasis_live_env_key_0123' });
  assert.equal(code, 0, out);
  assert.match(out, /5\. OASIS Route \(self-hosted gateway\)/);
  assert.equal(seen.auth, 'Bearer oasis_live_env_key_0123');
});
