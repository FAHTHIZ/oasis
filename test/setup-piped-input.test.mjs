// Regression: `oasis setup < /dev/null` printed its first question and exited 0
// with nothing saved; piped answers after the first were dropped (readline
// discards lines that arrive before the next question), and the API key could
// not be piped at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function runSetup(home, input) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
    for (const key of Object.keys(env)) if (/^OASIS_(MODEL|BASE_URL|PROTOCOL|LOCAL_API_KEY|API_KEY)$|_API_KEY$/.test(key)) delete env[key];
    const child = spawn(process.execPath, [CLI, 'setup'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test('setup with no input stops with an explanation and a failing exit code', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-setup-eof-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { code, out } = await runSetup(home, '');
  assert.equal(code, 1, out);
  assert.match(out, /input ended before a choice was made, so nothing was saved/);
  assert.match(out, /oasis connect KEY/);
});

test('setup answered through a pipe, API key included, saves a verified provider', async (t) => {
  let auth = '';
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    auth = req.headers.authorization || auth;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'oasis_connection_probe', arguments: '{"ready":true}' } }] } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-setup-pipe-'));
  t.after(async () => { server.close(); await rm(home, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  // API key > Other endpoint > protocol, URL, model, key.
  const { code, out } = await runSetup(home, ['1', '5', 'openai-compatible', base, 'piped-model', 'sk-piped-secret-0123'].join('\n') + '\n');
  assert.equal(code, 0, out);
  assert.match(out, /Provider responded successfully/);
  assert.doesNotMatch(out, /sk-piped-secret/, 'the piped key is not echoed');
  assert.equal(auth, 'Bearer sk-piped-secret-0123');
  const saved = JSON.parse(await readFile(path.join(home, '.config', 'oasis', 'config.json'), 'utf8'));
  assert.equal(saved.model, 'piped-model');
  assert.equal(saved.baseURL, base);
});
