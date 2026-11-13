import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('web page is served with a hash-based Content-Security-Policy covering every inline script', async (t) => {
  const { startOasisWebServer, pageContentSecurityPolicy } = await import('../src/web.mjs');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-csp-'));
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env: { OASIS_CONFIG_DIR: path.join(root, 'c'), HOME: root }, token: 'test-runtime-token-0123456789' });
  t.after(() => app.close());
  const response = await fetch('http://127.0.0.1:' + app.port + '/app/');
  const html = await response.text();
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp.split(';').find((d) => d.trim().startsWith('script-src')), /unsafe-inline|unsafe-eval/);
  let inline = 0;
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(match[1] || '')) continue;
    inline++;
    assert.ok(csp.includes("'sha256-" + createHash('sha256').update(match[2]).digest('base64') + "'"), 'inline script ' + inline + ' is allowed');
  }
  assert.ok(inline >= 1, 'the import map is an inline script');
  assert.doesNotMatch(html, /\son[a-z]+="/, 'no inline event handlers (CSP would block them)');
  const frame = (await fetch('http://127.0.0.1:' + app.port + '/app/sandbox.html')).headers.get('content-security-policy');
  assert.match(frame, /worker-src blob:/, 'the JavaScript sandbox frame may start its blob workers');
  assert.match(frame, /script-src 'self' blob: 'unsafe-eval'/);
  assert.match(frame, /connect-src 'none'/);
  assert.match(pageContentSecurityPolicy('<script>a()</script><script src="/x.js"></script>'), /script-src 'self' 'sha256-[^']+'(;|$)/);
});
