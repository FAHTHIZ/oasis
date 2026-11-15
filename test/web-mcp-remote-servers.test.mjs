import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

// Settings → Tools listed only mcp-servers.json, so a remote server added with
// `oasis mcp add --transport http` (saved in mcp.json) was invisible there.
test('web /api/mcp lists mcp.json servers (query hidden) and /api/mcp/remote turns them off, on and removes them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-mcp-remote-'));
  const config = path.join(root, 'config');
  await mkdir(config, { recursive: true });
  const file = path.join(config, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: {
    docs: { type: 'http', url: 'https://example.com/mcp?api_key=secret-value-123', headers: { Authorization: 'Bearer hidden-token' } },
    old: { type: 'sse', url: 'https://example.com/sse', disabled: true }
  } }));
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env: { OASIS_CONFIG_DIR: config }, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/api/mcp/remote', { method: 'POST', body: '{}' })).status, 401);

  const listed = await (await fetch(base + '/api/mcp', { headers })).json();
  const text = JSON.stringify(listed);
  assert.doesNotMatch(text, /secret-value-123|hidden-token/);
  assert.deepEqual(listed.remote.map((s) => [s.name, s.type, s.url, s.enabled]), [
    ['docs', 'http', 'https://example.com/mcp?…', true],
    ['old', 'sse', 'https://example.com/sse', false]
  ]);

  const post = (body) => fetch(base + '/api/mcp/remote', { method: 'POST', headers, body: JSON.stringify(body) });
  const off = await post({ name: 'docs', action: 'disable' });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).remote.find((s) => s.name === 'docs').enabled, false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcpServers.docs.disabled, true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcpServers.docs.url, 'https://example.com/mcp?api_key=secret-value-123', 'the saved URL is not rewritten');
  assert.equal((await post({ name: 'old', action: 'enable' })).status, 200);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcpServers.old.disabled, undefined);
  const removed = await (await post({ name: 'old', action: 'remove' })).json();
  assert.deepEqual(removed.remote.map((s) => s.name), ['docs']);
  assert.equal((await post({ name: 'missing', action: 'remove' })).status, 404);
  assert.equal((await post({ name: 'docs', action: 'explode' })).status, 400);
});
