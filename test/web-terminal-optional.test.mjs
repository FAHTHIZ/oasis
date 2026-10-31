import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

test('missing terminal renderer files return harmless assets instead of server errors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-no-terminal-'));
  const app = await startOasisWebServer({
    root,
    assetRoot: root,
    host: '127.0.0.1',
    port: 0,
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const assets = [
    ['/assets/vendor/xterm.js', 'text/javascript'],
    ['/assets/vendor/xterm.css', 'text/css'],
    ['/assets/vendor/xterm-addon-fit.js', 'text/javascript']
  ];

  for (const [url, expectedType] of assets) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200, url + ' must not fail when the optional file is missing');
    assert.ok(
      (response.headers.get('content-type') || '').startsWith(expectedType),
      url + ' must retain its correct content type'
    );
    assert.equal(response.headers.get('cache-control'), 'no-store', 'fallback assets must not be cached as real terminal files');
    const body = await response.text();
    assert.match(body, /optional OASIS terminal/i);
    if (url.endsWith('.js')) assert.doesNotThrow(() => new Function(body), url + ' must remain a valid JavaScript file');
  }
});
