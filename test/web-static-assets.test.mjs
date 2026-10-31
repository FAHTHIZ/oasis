import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

test('browser server serves branded app-shell assets with the correct content types', async (t) => {
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
  const assets = [
    ['/assets/oasis-interface.css', 'text/css'],
    ['/assets/oasis-mark.svg', 'image/svg+xml'],
    ['/assets/oasis-logo.svg', 'image/svg+xml'],
    ['/assets/oasis-readme-banner.svg', 'image/svg+xml']
  ];

  for (const [url, expectedType] of assets) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200, url + ' must return HTTP 200');
    assert.ok(
      (response.headers.get('content-type') || '').startsWith(expectedType),
      url + ' must use content type ' + expectedType
    );
    assert.ok((await response.text()).length > 0, url + ' must not be empty');
  }
});
