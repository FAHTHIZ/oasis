import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePreviewPath, protectedPreviewPath, rewriteRootPaths, PREVIEW_SANDBOX } from '../src/web-preview.mjs';
import { previewTarget } from '../app/core/preview.mjs';

test('preview address bar: ports, local URLs and files', () => {
  assert.deepEqual(previewTarget('5173'), { port: 5173, path: '' });
  assert.deepEqual(previewTarget(':3000/admin'), { port: 3000, path: 'admin' });
  assert.deepEqual(previewTarget('http://localhost:8080/a?b=1'), { port: 8080, path: 'a?b=1' });
  assert.deepEqual(previewTarget('./docs/index.html'), { port: null, path: 'docs/index.html' });
  assert.deepEqual(parsePreviewPath('/preview/' + 'k'.repeat(32) + '/:5173/x.js'), { key: 'k'.repeat(32), port: 5173, rest: 'x.js' });
  assert.equal(parsePreviewPath('/preview/short/x'), null);
});

test('protected paths and root-path rewriting', () => {
  for (const rel of ['.env', '.git/config', 'a/.git/HEAD', '.oasis/sessions/x.json', 'id_rsa']) assert.equal(protectedPreviewPath(rel), true, rel);
  for (const rel of ['index.html', '.oasis/recordings/browser-1.html', 'src/app.js']) assert.equal(protectedPreviewPath(rel), false, rel);
  const html = '<link href="/a.css"><script src="/b.js"></script><img srcset="/c.png 1x, /d.png 2x"><a href="//cdn.example/x">x</a><script type=module>import x from "/m.js"</script><div style="background:url(/e.png)">';
  const out = rewriteRootPaths(html, '/preview/K/', 'text/html; charset=utf-8');
  assert.match(out, /href="\/preview\/K\/a\.css"/);
  assert.match(out, /src="\/preview\/K\/b\.js"/);
  assert.match(out, /srcset="\/preview\/K\/c\.png 1x, \/preview\/K\/d\.png 2x"/);
  assert.match(out, /href="\/\/cdn\.example\/x"/, 'protocol-relative URLs stay');
  assert.match(out, /from "\/preview\/K\/m\.js"/);
  assert.match(out, /url\(\/preview\/K\/e\.png\)/);
  assert.equal(rewriteRootPaths('a{b:url("/f.woff2")}', '/preview/K/', 'text/css'), 'a{b:url("/preview/K/f.woff2")}');
});

test('web: preview serves project files sandboxed, refuses secrets and proxies a dev server', async (t) => {
  const { startOasisWebServer } = await import('../src/web.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-preview-'));
  await writeFile(path.join(root, 'index.html'), '<link rel=stylesheet href="/site.css"><h1>Hi</h1>');
  await writeFile(path.join(root, 'site.css'), 'h1{color:red}');
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'index.html'), 'docs');
  for (const name of ['model.glb', 'lib.cjs', 'notes.md', 'app.ts']) await writeFile(path.join(root, name), 'x');
  await mkdir(path.join(root, '.oasis', 'recordings'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'recordings', 'browser-2026-01-01T00-00-00.html'), '<p>rec</p>');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-preview-out-'));
  await writeFile(path.join(outside, 'secret.txt'), 'nope');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

  const dev = http.createServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { location: '/landing' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'set-cookie': 'a=b' });
    res.end('<script src="/main.js"></script>auth=' + (req.headers.authorization || 'none') + ' url=' + req.url);
  });
  await new Promise((resolve) => dev.listen(0, '127.0.0.1', resolve));
  t.after(() => dev.close());

  const env = { OASIS_CONFIG_DIR: path.join(root, '.oasis-config'), HOME: root, OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token });
  t.after(() => app.close());
  const origin = 'http://127.0.0.1:' + app.port;
  assert.equal((await fetch(origin + '/api/preview')).status, 401);
  const info = await (await fetch(origin + '/api/preview', { headers: { authorization: 'Bearer ' + token } })).json();
  assert.match(info.base, /^\/preview\/[\w-]{32,}\/$/);
  assert.notEqual(info.base.split('/')[2], token, 'the preview key is not the access key');
  assert.deepEqual(info.recordings, ['.oasis/recordings/browser-2026-01-01T00-00-00.html']);

  // A sandboxed page sends Origin: null; that must still work.
  const page = await fetch(origin + info.base + 'index.html', { headers: { origin: 'null' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), PREVIEW_SANDBOX);
  assert.doesNotMatch(PREVIEW_SANDBOX, /allow-same-origin/);
  assert.match(await page.text(), new RegExp('href="' + info.base + 'site.css"'));
  assert.equal((await fetch(origin + info.base + 'site.css', { headers: { origin: 'null' } })).headers.get('content-type'), 'text/css; charset=utf-8');
  const typeOf = async (name) => (await fetch(origin + info.base + name)).headers.get('content-type');
  assert.equal(await typeOf('model.glb'), 'model/gltf-binary');
  assert.equal(await typeOf('lib.cjs'), 'text/javascript; charset=utf-8');
  assert.equal(await typeOf('notes.md'), 'text/plain; charset=utf-8');
  assert.equal(await typeOf('app.ts'), 'text/plain; charset=utf-8');
  assert.equal((await fetch(origin + info.base + '.env')).status, 403);
  assert.equal((await fetch(origin + info.base + 'link.txt')).status, 403);
  assert.equal((await fetch(origin + info.base + 'missing.html')).status, 404);
  const folder = await fetch(origin + info.base + 'docs', { redirect: 'manual' });
  assert.equal(folder.status, 308);
  assert.equal(folder.headers.get('location'), info.base + 'docs/');
  assert.equal(await (await fetch(origin + info.base + 'docs/')).text(), 'docs');
  assert.equal((await fetch(origin + info.base + '.oasis/recordings/browser-2026-01-01T00-00-00.html')).status, 200);
  assert.equal((await fetch(origin + '/preview/' + 'x'.repeat(32) + '/index.html')).status, 404, 'a wrong key opens nothing');

  const proxied = await fetch(origin + info.base + ':' + dev.address().port + '/hello?q=1', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers.get('x-frame-options'), null);
  assert.equal(proxied.headers.get('set-cookie'), null);
  assert.equal(proxied.headers.get('content-security-policy'), PREVIEW_SANDBOX);
  const body = await proxied.text();
  assert.match(body, /auth=none/, 'the access key never reaches the dev server');
  assert.match(body, /url=\/hello\?q=1/);
  assert.match(body, new RegExp('src="' + info.base + ':' + dev.address().port + '/main.js"'));
  const moved = await fetch(origin + info.base + ':' + dev.address().port + '/go', { redirect: 'manual' });
  assert.equal(moved.headers.get('location'), info.base + ':' + dev.address().port + '/landing');
  assert.equal((await fetch(origin + info.base + ':' + app.port + '/api/status')).status, 400, 'the OASIS port itself is not proxied');
  const closed = await fetch(origin + info.base + ':80/');
  assert.equal(closed.status, 400);
});
