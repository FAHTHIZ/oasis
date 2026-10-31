import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

const [html, serviceWorker, manifestText] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8')
]);

function addAssetReference(set, value) {
  if (!/^(?:\.\/|\/)?assets\//.test(value)) return;
  set.add(new URL(value, 'http://127.0.0.1/').pathname);
}

test('the browser server delivers every asset referenced by the app shell', async (t) => {
  const references = new Set();

  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    addAssetReference(references, match[1]);
  }

  const shell = serviceWorker.match(/APP_SHELL\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(shell, 'the service worker must declare its app shell');
  for (const match of shell[1].matchAll(/['"]([^'"]+)['"]/g)) {
    addAssetReference(references, match[1]);
  }

  const manifest = JSON.parse(manifestText);
  for (const icon of manifest.icons || []) addAssetReference(references, icon.src);

  const assets = [...references].sort();
  assert.ok(assets.length > 0, 'expected local app-shell assets to test');

  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-static-assets-'));
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  for (const asset of assets) {
    const extension = path.extname(asset).toLowerCase();
    const expectedType = extension === '.svg'
      ? 'image/svg+xml'
      : extension === '.css'
        ? 'text/css'
        : extension === '.js'
          ? 'text/javascript'
          : null;
    assert.ok(expectedType, 'add a content-type expectation for ' + asset);

    const response = await fetch(base + asset);
    assert.equal(response.status, 200, asset + ' must return HTTP 200');
    assert.ok(
      (response.headers.get('content-type') || '').startsWith(expectedType),
      asset + ' must use content type ' + expectedType
    );
    assert.ok((await response.text()).length > 0, asset + ' must not be empty');
  }
});

test('service worker serves app CSS/JS network-first so updates are never mixed with stale assets', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const tail = sw.slice(sw.indexOf("startsWith('/assets/vendor/')"));
  assert.ok(tail.length > 40, 'vendor files are the only cache-first branch');
  const appBranch = tail.slice(tail.indexOf('return;'));
  assert.match(appBranch, /event\.respondWith\(\s*fetch\(request\)/, 'non-vendor assets must try the network first');
  assert.match(appBranch, /caches\.match\(request\)/, 'and fall back to the cache offline');
});
