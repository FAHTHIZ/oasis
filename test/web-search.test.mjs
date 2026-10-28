import test from 'node:test';
import assert from 'node:assert/strict';
import { webSearch, parseDuckDuckGoHtml, searchBackend, webSearchEnabled } from '../src/web-search.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import os from 'node:os';

const DDG = `<div class="result results_links web-result "><div class="links_main result__body">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Freadline.html&amp;rut=x">Readline &amp; <b>Node</b></a>
<a class="result__snippet" href="x">Use <b>question()</b> with a signal.</a></div></div>
<div class="result results_links web-result "><a rel="nofollow" class="result__a" href="https://spam.example/x">Spam</a><a class="result__snippet">bad</a></div>`;

function fakeFetch(calls, body, { status = 200, json = false } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: status < 400, status, text: async () => body, json: async () => (json ? body : JSON.parse(body)) };
  };
}

test('DuckDuckGo results are parsed, unwrapped, and domain filtered', async () => {
  assert.deepEqual(parseDuckDuckGoHtml(DDG)[0], { title: 'Readline & Node', url: 'https://nodejs.org/api/readline.html', snippet: 'Use question() with a signal.' });
  const calls = [];
  const result = await webSearch({ query: 'readline signal', blocked_domains: ['spam.example'] }, { env: {}, fetch: fakeFetch(calls, DDG) });
  assert.equal(result.backend, 'duckduckgo');
  assert.deepEqual(result.results.map((r) => r.url), ['https://nodejs.org/api/readline.html']);
  assert.match(calls[0].url, /html\.duckduckgo\.com\/html\/\?q=readline%20signal/);
  const only = await webSearch({ query: 'x', allowed_domains: ['nodejs.org'] }, { env: {}, fetch: fakeFetch([], DDG) });
  assert.equal(only.results.length, 1);
});

test('rate limited keyless search explains how to configure a backend', async () => {
  const result = await webSearch({ query: 'x' }, { env: {}, fetch: fakeFetch([], '<html>anomaly</html>', { status: 202 }) });
  assert.match(result.error, /TAVILY_API_KEY/);
});

test('Tavily, Brave, and SearXNG backends send the right requests', async () => {
  let calls = [];
  const tavily = await webSearch({ query: 'q', max_results: 2 }, { env: { TAVILY_API_KEY: 'tv' }, fetch: fakeFetch(calls, { results: [{ title: 'T', url: 'https://a.dev/1', content: 'c' }] }, { json: true }) });
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tv');
  assert.equal(tavily.results[0].url, 'https://a.dev/1');
  calls = [];
  await webSearch({ query: 'q' }, { env: { BRAVE_SEARCH_API_KEY: 'bk' }, fetch: fakeFetch(calls, { web: { results: [] } }, { json: true }) });
  assert.equal(calls[0].init.headers['x-subscription-token'], 'bk');
  calls = [];
  await webSearch({ query: 'q' }, { env: { OASIS_SEARXNG_URL: 'http://127.0.0.1:8888/' }, fetch: fakeFetch(calls, { results: [] }, { json: true }) });
  assert.equal(calls[0].url, 'http://127.0.0.1:8888/search?format=json&q=q');
  assert.equal(searchBackend({}), 'duckduckgo');
  await assert.rejects(webSearch({ query: ' ' }, { env: {} }), /needs a query/);
});

test('OASIS_WEB_SEARCH=off removes the tool from sessions', async (t) => {
  assert.equal(webSearchEnabled({ OASIS_WEB_SEARCH: 'off' }), false);
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' };
  const on = await createSession({ root: os.tmpdir(), config, env: { ...process.env, OASIS_WEB_SEARCH: '' } });
  const off = await createSession({ root: os.tmpdir(), config, env: { ...process.env, OASIS_WEB_SEARCH: 'off' } });
  t.after(() => { closeSession(on); closeSession(off); });
  assert.ok(on.toolDefinitions.some((tool) => tool.function.name === 'web_search'));
  assert.ok(!off.toolDefinitions.some((tool) => tool.function.name === 'web_search'));
});
