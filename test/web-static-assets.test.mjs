import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');

const TYPES = { '.svg': 'image/svg+xml', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.png': 'image/png' };

test('the browser server delivers every local file the app page references', async (t) => {
  const references = new Set();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    if (/^[a-z]+:/i.test(match[1]) || match[1].startsWith('#')) continue;
    references.add(new URL(match[1], 'http://127.0.0.1/app/').pathname);
  }
  assert.ok(references.size >= 3, 'expected local app assets to test');

  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-static-assets-'));
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env: { OASIS_CONFIG_DIR: path.join(root, 'c'), HOME: root }, token: 'test-runtime-token-0123456789' });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.port;
  for (const asset of [...references].sort()) {
    const expected = TYPES[path.extname(asset).toLowerCase()];
    assert.ok(expected, 'add a content-type expectation for ' + asset);
    const response = await fetch(base + asset);
    assert.equal(response.status, 200, asset + ' must return HTTP 200');
    assert.ok((response.headers.get('content-type') || '').startsWith(expected), asset + ' must use content type ' + expected);
    assert.ok((await response.text()).length > 0, asset + ' must not be empty');
  }
  // The terminal renderer the app loads on demand.
  for (const asset of ['/assets/vendor/xterm.js', '/assets/vendor/xterm.css', '/assets/vendor/xterm-addon-fit.js']) {
    assert.equal((await fetch(base + asset)).status, 200, asset);
  }
});

test('the old offline worker retires itself instead of caching the removed page', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /caches\.delete/);
  assert.match(sw, /registration\.unregister\(\)/);
  assert.doesNotMatch(sw, /addEventListener\('fetch'/, 'it must not answer requests any more');
});
