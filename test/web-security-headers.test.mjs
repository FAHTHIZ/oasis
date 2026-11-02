import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('desktop permission policy allows only microphone and clipboard for the app origin', async () => {
  const { allowPermission } = await import('../desktop/permissions.mjs');
  const app = 'http://127.0.0.1:4310';
  assert.equal(allowPermission('media', { requestingUrl: app + '/', mediaTypes: ['audio'] }, app), true);
  assert.equal(allowPermission('media', { requestingUrl: app + '/', mediaTypes: ['audio', 'video'] }, app), false);
  assert.equal(allowPermission('media', { requestingUrl: app + '/', mediaType: 'video' }, app), false);
  assert.equal(allowPermission('media', { requestingUrl: 'https://evil.example/', mediaTypes: ['audio'] }, app), false);
  assert.equal(allowPermission('media', { requestingUrl: app + '/', mediaTypes: ['audio'], isMainFrame: false }, app), false);
  assert.equal(allowPermission('clipboard-sanitized-write', { requestingUrl: app }, app), true);
  assert.equal(allowPermission('notifications', { requestingUrl: app + '/' }, app), true, 'turn-finished notifications');
  for (const permission of ['geolocation', 'midi', 'pointerLock', 'openExternal', 'display-capture', 'hid', 'serial', 'usb']) {
    assert.equal(allowPermission(permission, { requestingUrl: app + '/' }, app), false, permission);
  }
  assert.equal(allowPermission('media', { requestingUrl: app, mediaTypes: ['audio'] }, null), false, 'nothing before the server is up');
});

test('web page is served with a hash-based Content-Security-Policy covering every inline script', async (t) => {
  const { startOasisWebServer, pageContentSecurityPolicy } = await import('../src/web.mjs');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-csp-'));
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env: { OASIS_CONFIG_DIR: path.join(root, 'c'), HOME: root }, token: 'test-runtime-token-0123456789' });
  t.after(() => app.close());
  const response = await fetch('http://127.0.0.1:' + app.port + '/');
  const html = await response.text();
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp.split(';').find((d) => d.trim().startsWith('script-src')), /unsafe-inline|unsafe-eval/);
  let inline = 0;
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(match[1] || '')) continue;
    inline++;
    assert.ok(csp.includes("'sha256-" + createHash('sha256').update(match[2]).digest('base64') + "'"), 'inline script ' + inline + ' is allowed');
  }
  assert.ok(inline >= 1);
  assert.doesNotMatch(html, /\son[a-z]+="/, 'no inline event handlers (CSP would block them)');
  assert.match(pageContentSecurityPolicy('<script>a()</script><script src="/x.js"></script>'), /script-src 'self' 'sha256-[^']+'(;|$)/);
});
