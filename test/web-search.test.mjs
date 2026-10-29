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


test('federated search fuses provider results and deduplicates tracking URL variants', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('api.tavily.com')) {
      return { ok: true, status: 200, json: async () => ({ results: [
        { title: 'Shared source', url: 'https://docs.example.com/guide?utm_source=one#top', content: 'A useful primary source.' },
        { title: 'Tavily only', url: 'https://tavily.example/page', content: 'Tavily result.' }
      ] }) };
    }
    if (String(url).includes('api.search.brave.com')) {
      return { ok: true, status: 200, json: async () => ({ web: { results: [
        { title: 'Shared source', url: 'https://docs.example.com/guide?utm_source=two', description: 'Shared evidence.' },
        { title: 'Brave only', url: 'https://brave.example/page', description: 'Brave result.' }
      ] } }) };
    }
    throw new Error('unexpected URL');
  };
  const result = await webSearch({ query: 'source fusion', strategy: 'federated', max_results: 5 }, {
    env: { TAVILY_API_KEY: 'test-tavily', BRAVE_SEARCH_API_KEY: 'test-brave' },
    fetch: fetchImpl
  });
  assert.equal(result.backend, 'federated');
  assert.deepEqual(result.providers, ['tavily', 'brave']);
  assert.equal(calls.length, 2);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].url, 'https://docs.example.com/guide');
  assert.equal(result.results[0].providerCount, 2);
  assert.deepEqual(new Set(result.results[0].providers), new Set(['tavily', 'brave']));
});

test('auto strategy preserves single-provider behavior and single mode uses legacy precedence', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ results: [{ title: 'One', url: 'https://example.org/a', content: 'content' }] }) };
  };
  const single = await webSearch({ query: 'q' }, { env: { TAVILY_API_KEY: 'tv' }, fetch: fetchImpl });
  assert.equal(single.backend, 'tavily');
  assert.equal(single.strategy, 'single');
  assert.equal(calls, 1);
  const legacyPriority = await webSearch({ query: 'q', strategy: 'single' }, {
    env: { TAVILY_API_KEY: 'tv', BRAVE_SEARCH_API_KEY: 'br' },
    fetch: fetchImpl
  });
  assert.equal(legacyPriority.backend, 'tavily');
  assert.equal(calls, 2);
});

test('Exa and Firecrawl adapters normalize their native result shapes', async () => {
  let exaRequest;
  const exa = await webSearch({ query: 'exa query', strategy: 'single' }, {
    env: { EXA_API_KEY: 'exa-secret' },
    fetch: async (url, init) => {
      exaRequest = { url: String(url), init };
      return { ok: true, status: 200, json: async () => ({ results: [
        { title: 'Exa docs', url: 'https://exa.example/docs', text: 'Highlights from Exa.' }
      ] }) };
    }
  });
  assert.equal(exa.backend, 'exa');
  assert.equal(exaRequest.url, 'https://api.exa.ai/search');
  assert.equal(exaRequest.init.headers['x-api-key'], 'exa-secret');
  assert.equal(exa.results[0].snippet, 'Highlights from Exa.');

  let firecrawlRequest;
  const firecrawl = await webSearch({ query: 'firecrawl query', strategy: 'single' }, {
    env: { FIRECRAWL_API_KEY: 'firecrawl-secret' },
    fetch: async (url, init) => {
      firecrawlRequest = { url: String(url), init };
      return { ok: true, status: 200, json: async () => ({ success: true, data: [
        { title: 'Firecrawl docs', url: 'https://firecrawl.example/docs', description: 'Firecrawl search result.' }
      ] }) };
    }
  });
  assert.equal(firecrawl.backend, 'firecrawl');
  assert.equal(firecrawlRequest.url, 'https://api.firecrawl.dev/v2/search');
  assert.equal(firecrawlRequest.init.headers.authorization, 'Bearer firecrawl-secret');
  assert.equal(firecrawl.results[0].snippet, 'Firecrawl search result.');
});

test('federated search keeps partial success and reports failure without exposing credentials', async () => {
  const result = await webSearch({ query: 'partial success', strategy: 'federated' }, {
    env: { TAVILY_API_KEY: 'never-return-this', BRAVE_SEARCH_API_KEY: 'also-secret' },
    fetch: async (url) => {
      if (String(url).includes('api.tavily.com')) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ web: { results: [
        { title: 'Working source', url: 'https://good.example/source', description: 'Available source.' }
      ] } }) };
    }
  });
  assert.equal(result.results.length, 1);
  assert.ok(result.providers.includes('brave'));
  assert.ok(result.providerErrors.some((item) => item.provider === 'tavily' && item.error === 'rate limited'));
  assert.equal(JSON.stringify(result).includes('never-return-this'), false);
  assert.equal(JSON.stringify(result).includes('also-secret'), false);
});

test('federated result domain filters are enforced locally', async () => {
  const result = await webSearch({ query: 'domain filter', strategy: 'federated', allowed_domains: ['trusted.example'] }, {
    env: { TAVILY_API_KEY: 'tv', BRAVE_SEARCH_API_KEY: 'br' },
    fetch: async (url) => {
      if (String(url).includes('api.tavily.com')) return { ok: true, status: 200, json: async () => ({ results: [
        { title: 'Trusted', url: 'https://trusted.example/one', content: 'yes' },
        { title: 'Untrusted', url: 'https://bad.example/two', content: 'no' }
      ] }) };
      return { ok: true, status: 200, json: async () => ({ web: { results: [
        { title: 'Other untrusted', url: 'https://elsewhere.example/two', description: 'no' }
      ] } }) };
    }
  });
  assert.deepEqual(result.results.map((item) => new URL(item.url).hostname), ['trusted.example']);
});
