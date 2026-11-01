import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loopbackFetch, providerFetch } from '../src/loopback-fetch.mjs';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('loopbackFetch sends method, headers and body and returns a standard Response', async (t) => {
  const base = await serve(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-seen-auth': req.headers.authorization || '' });
      res.end(JSON.stringify({ method: req.method, body, length: req.headers['content-length'] }));
    });
  });
  const response = await loopbackFetch(base + '/v1/chat/completions', { method: 'POST', headers: new Headers({ authorization: 'Bearer k', 'content-type': 'application/json' }), body: '{"a":"é"}' });
  assert.equal(response.status, 201);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('x-seen-auth'), 'Bearer k');
  assert.deepEqual(await response.json(), { method: 'POST', body: '{"a":"é"}', length: String(Buffer.byteLength('{"a":"é"}')) });
});

test('loopbackFetch streams server-sent events as they arrive and waits for slow headers', async (t) => {
  const base = await serve(t, (req, res) => {
    setTimeout(() => { // a slow prompt read: headers only after a delay
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.end('data: two\n\n'); }, 50);
    }, 300);
  });
  const response = await loopbackFetch(base, { method: 'POST', body: '{}' });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
  assert.equal(text, 'data: one\n\ndata: two\n\n');
});

test('loopbackFetch honors AbortSignal before and during the request', async (t) => {
  const base = await serve(t, () => { /* never answers */ });
  const already = new AbortController(); already.abort();
  await assert.rejects(loopbackFetch(base, { signal: already.signal }), { name: 'AbortError' });
  const controller = new AbortController();
  const pending = loopbackFetch(base, { method: 'POST', body: 'x', signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('loopbackFetch reports connection failures as TypeError like fetch, so callers retry them', async () => {
  await assert.rejects(loopbackFetch('http://127.0.0.1:9/'), (error) => error instanceof TypeError && /fetch failed/.test(error.message));
});

test('providerFetch uses node:http only for local servers and never bypasses a replaced fetch', (t) => {
  assert.equal(providerFetch(true), loopbackFetch);
  assert.equal(providerFetch(false), globalThis.fetch);
  const original = globalThis.fetch;
  const stub = async () => new Response('stub');
  globalThis.fetch = stub;
  t.after(() => { globalThis.fetch = original; });
  assert.equal(providerFetch(true), stub);
});

test('a connection dropped mid-body surfaces as TypeError("terminated"), like fetch', async (t) => {
  const base = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\n\n');
    setTimeout(() => res.socket.destroy(), 30);
  });
  const response = await loopbackFetch(base, { method: 'POST', body: '{}' });
  await assert.rejects(response.text(), (error) => error instanceof TypeError && error.message === 'terminated');
});
