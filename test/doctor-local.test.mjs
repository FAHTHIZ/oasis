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
