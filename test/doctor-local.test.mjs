import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('oasis doctor reports a local llama-server window, the tool profile and how to fix a small window', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/props') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-doctor-local-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [CLI, 'doctor'], { cwd: dir, env: { ...process.env, OASIS_CONFIG_DIR: dir, HOME: dir, OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_PROTOCOL: 'openai-compatible', OASIS_MODEL: 'tiny', NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.match(out, /Local model server: llama-server, 8,192-token context window/);
  assert.match(out, /Tool profile for this window: small/);
  assert.match(out, /--ctx-size 32768/);
  assert.match(out, /OASIS_LOCAL_CONTEXT_PROBE=1/, 'A non-default port should explain that the runtime does not probe it.');
});

test('oasis doctor lists the backup models that oasis connect saved in the config', async (t) => {
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-doctor-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'main-model', apiKey: '', keyless: true, fallbackModel: 'backup-a,backup-b' }));
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, HOME: dir, NO_COLOR: '1' };
  for (const key of Object.keys(env)) if (/^(OASIS_(BASE_URL|MODEL|PROTOCOL|API_KEY|FALLBACK_MODEL)|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
  const child = spawn(process.execPath, [CLI, 'doctor'], { cwd: dir, env });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.match(out, /Model: main-model/);
  assert.match(out, /Fallback models: backup-a, backup-b/);
});

test('oasis doctor names the configured contextWindow when the local server does not report one', async (t) => {
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-doctor-window-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: '', keyless: true, contextWindow: 65536 }));
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, HOME: dir, NO_COLOR: '1' };
  for (const key of Object.keys(env)) if (/^(OASIS_(BASE_URL|MODEL|PROTOCOL|API_KEY|FALLBACK_MODEL|CONTEXT_WINDOW)|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
  const child = spawn(process.execPath, [CLI, 'doctor'], { cwd: dir, env });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.match(out, /using the configured 65,536-token window/);
  assert.doesNotMatch(out, /set contextWindow in config if replies get cut off/, 'Do not ask for a setting that is already set.');
});
