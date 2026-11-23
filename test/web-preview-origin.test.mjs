import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPreviewHandler } from '../src/web-preview.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('preview proxy: only a dev app posting to its own port loses its Origin', async (t) => {
  // Regression: the proxy deleted Origin on every request, so a sandboxed preview
  // page (say an untrusted repo's HTML file) could POST to /preview/KEY/:11434/…
  // and reach Ollama, Jupyter or another local service with its Origin check gone.
  const seen = [];
  const local = http.createServer((req, res) => { seen.push(req.headers.origin); res.end('ok'); });
  const localPort = await listen(local);
  const key = 'k'.repeat(32);
  const preview = createPreviewHandler({ getRoot: () => process.cwd(), key });
  const front = http.createServer(async (req, res) => { if (!await preview.handle(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.statusCode = 404; res.end(); } });
  const frontPort = await listen(front);
  t.after(() => { local.close(); front.close(); });
  const url = 'http://127.0.0.1:' + frontPort + '/preview/' + key + '/:' + localPort + '/api/pull';
  const post = async (referer) => (await fetch(url, { method: 'POST', body: '{}', headers: { origin: 'null', ...(referer ? { referer } : {}) } })).text();
  const base = 'http://127.0.0.1:' + frontPort + '/preview/' + key + '/';
  await post(base + 'evil.html');
  await post(base + ':5173/');
  await post('');
  await post(base + ':' + localPort + '/form');
  await fetch(url);
  assert.deepEqual(seen, ['null', 'null', 'null', undefined, undefined]);
});

test('a malformed percent escape in a preview path is a 400, not a server error', async () => {
  const handler = createPreviewHandler({ getRoot: () => process.cwd() });
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end() { this.ended = true; } };
  const handled = await handler.handle({ method: 'GET', headers: {} }, res, new URL('http://127.0.0.1' + handler.base(null) + '%E0%A4%A'));
  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.match(res.headers['content-security-policy'], /^sandbox /);
});
