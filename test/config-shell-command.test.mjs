// `oasis config get|set|list` ignored its arguments and printed the provider
// summary (exit 0), so `oasis config set model X` silently did nothing. And
// /config set model wrote settings.json, which sessions never read: "Saved as the
// default model" did not change the model. Both now save to the provider config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function oasis(args, home, cwd, extra = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1', ...extra };
    for (const key of ['OASIS_MODEL', 'OASIS_BASE_URL', 'OASIS_PROTOCOL', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) if (!(key in extra)) delete env[key];
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('oasis config list/get/set work from a shell and the default model is used', async (t) => {
  const models = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { models.push(JSON.parse(body).model); } catch {}
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-proj-'));
  t.after(async () => { server.close(); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });

  let r = await oasis(['config', 'set', 'model', 'first'], home, project);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /No model provider is saved yet/);

  const dir = path.join(home, '.config', 'oasis');
  await mkdir(dir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ protocol: 'openai', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'first', apiKey: 'local-key' }), { mode: 0o600 });

  r = await oasis(['config', 'get', 'model'], home, project);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^model = first$/m);
  r = await oasis(['config', 'set', 'model', 'second'], home, project);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Saved second as the default model/);
  const saved = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(saved.model, 'second');
  assert.equal(saved.apiKey, 'local-key');
  r = await oasis(['-p', 'hi'], home, project);
  assert.equal(r.code, 0, r.out);
  assert.equal(models.at(-1), 'second');

  r = await oasis(['config', 'set', 'verbose', 'on'], home, project);
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).verbose, true);
  r = await oasis(['config', 'list'], home, project);
  assert.match(r.out, /Verbose output\s+true/);
  assert.match(r.out, /Model\s+second/);
  r = await oasis(['config', 'set', 'theme', 'nosuch'], home, project);
  assert.equal(r.code, 1);
  r = await oasis(['config', 'get', 'nosuch'], home, project);
  assert.equal(r.code, 1);
  r = await oasis(['config', 'frobnicate'], home, project);
  assert.equal(r.code, 1);
  assert.match(r.out, /Usage: oasis config/);
  // A bare `oasis config` still shows the provider summary, key masked.
  r = await oasis(['config'], home, project);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /local-key/);
});
