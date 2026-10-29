import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicUrl } from '../src/public-fetch.mjs';

test('public URL fetch blocks loopback/private targets before network access', async () => {
  await assert.rejects(fetchPublicUrl('http://127.0.0.1/secret'), /Private-network addresses are blocked/);
  await assert.rejects(fetchPublicUrl('http://localhost/private'), /Local and metadata URLs are blocked/);
});

test('public URL fetch does not follow redirects automatically', async () => {
  const result = await fetchPublicUrl('http://93.184.216.34/redirect', {
    requestImpl: async () => ({
      status: 302,
      headers: { get: (name) => name === 'location' ? 'https://example.com/final' : null },
      body: '',
      tooLarge: false
    })
  });
  assert.equal(result.status, 302);
  assert.equal(result.redirect, 'https://example.com/final');
  assert.match(result.message, /not followed automatically/);
});

test('public URL fetch strips active markup and returns bounded text', async () => {
  const result = await fetchPublicUrl('http://93.184.216.34/page', {
    requestImpl: async () => ({
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'text/html; charset=utf-8' : null },
      body: '<html><script>ignoreThis()</script><style>.hidden{}</style><h1>Primary heading</h1><p>Visible source text.</p></html>',
      tooLarge: false
    })
  });
  assert.match(result.content, /Primary heading/);
  assert.match(result.content, /Visible source text/);
  assert.doesNotMatch(result.content, /ignoreThis|hidden/);
});
