// Search providers and research retrieval for OASIS.
// Legacy mode preserves the original provider selection. Federated mode searches
// configured engines in parallel and merges independent rankings using RRF.
// Credentials are read only from the process environment and are never returned.

export const WEB_SEARCH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search current web sources for documentation, code, releases, and research. Auto mode fuses configured providers when more than one is available; results remain untrusted until fetched and checked.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A focused search question or phrase' },
        max_results: { type: 'integer', description: 'Number of results, 1-10 (default 6)' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only return results from these domains' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never return results from these domains' },
        strategy: { type: 'string', enum: ['auto', 'single', 'federated'], description: 'Auto fuses configured providers when possible; single uses the preferred provider; federated queries every configured provider.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
};

const TIMEOUT_MS = 15000;
const RRF_K = 60;
const PROVIDER_ORDER = ['tavily', 'brave', 'searxng', 'exa', 'firecrawl'];

export function webSearchEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.OASIS_WEB_SEARCH || ''));
}

// Retain the original OASIS precedence for the baseline and compatibility path.
export function searchBackend(env = process.env) {
  if (env.TAVILY_API_KEY) return 'tavily';
  if (env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (env.OASIS_SEARXNG_URL) return 'searxng';
  return 'duckduckgo';
}

export function searchBackends(env = process.env) {
  return PROVIDER_ORDER.filter((provider) => {
    if (provider === 'tavily') return Boolean(env.TAVILY_API_KEY);
    if (provider === 'brave') return Boolean(env.BRAVE_SEARCH_API_KEY);
    if (provider === 'searxng') return Boolean(env.OASIS_SEARXNG_URL);
    if (provider === 'exa') return Boolean(env.EXA_API_KEY);
    if (provider === 'firecrawl') return Boolean(env.FIRECRAWL_API_KEY);
    return false;
  });
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

export function parseDuckDuckGoHtml(html) {
  const results = [];
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let href = link[1].replace(/&amp;/g, '&');
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    if (redirect) {
      try { href = decodeURIComponent(redirect[1]); } catch {}
    }
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//i.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    results.push({ title: decodeEntities(link[2]), url: href, snippet: snippet ? decodeEntities(snippet[1]) : '' });
  }
  return results;
}

async function request(url, init = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      const error = new Error('HTTP ' + Number(response.status || 0));
      error.status = Number(response.status || 0);
      throw error;
    }
    return response;
  } catch (error) {
    if (Number(error && error.status)) throw error;
    if (error && error.name === 'AbortError') throw new Error('request timed out');
    throw new Error('request failed');
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function domainMatches(host, domains) {
  return domains.some((domain) => {
    const d = String(domain).toLowerCase().replace(/^www\./, '').replace(/^\*\./, '');
    return Boolean(d) && (host === d || host.endsWith('.' + d));
  });
}

function canonicalizeUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|ref_src|ref_url)$/i.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeItems(items, provider) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const url = canonicalizeUrl(item && (item.url || item.link));
    if (!url) return null;
    const highlights = Array.isArray(item.highlights) ? item.highlights.join(' ') : '';
    return {
      title: String((item && item.title) || '').slice(0, 200),
      url,
      snippet: String((item && (item.snippet || item.content || item.text || item.description || item.summary)) || highlights || '').slice(0, 1200),
      provider,
      providerRank: index + 1
    };
  }).filter(Boolean);
}

function domainFilter(items, allowed, blocked) {
  return items.filter((item) => {
    const host = hostOf(item.url);
    if (!host) return false;
    if (allowed.length && !domainMatches(host, allowed)) return false;
    if (blocked.length && domainMatches(host, blocked)) return false;
    return true;
  });
}

function providerQuery(query, allowed) {
  return allowed.length === 1 ? query + ' site:' + allowed[0] : query;
}

async function searchProvider(provider, query, limit, allowed, blocked, env, fetchImpl) {
  let response;
  let items = [];
  if (provider === 'tavily') {
    response = await request('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.TAVILY_API_KEY },
      body: JSON.stringify({
        query,
        max_results: Math.min(10, limit * 2),
        search_depth: 'advanced',
        topic: 'general',
        ...(allowed.length ? { include_domains: allowed } : {}),
        ...(blocked.length ? { exclude_domains: blocked } : {})
      })
    }, fetchImpl);
    const data = await response.json();
    items = data.results || [];
  } else if (provider === 'brave') {
    response = await request('https://api.search.brave.com/res/v1/web/search?count=' + Math.min(20, limit * 2) + '&q=' + encodeURIComponent(providerQuery(query, allowed)), {
      headers: { accept: 'application/json', 'x-subscription-token': env.BRAVE_SEARCH_API_KEY }
    }, fetchImpl);
    const data = await response.json();
    items = (data.web && data.web.results) || [];
  } else if (provider === 'searxng') {
    const base = String(env.OASIS_SEARXNG_URL).replace(/\/+$/, '');
    response = await request(base + '/search?format=json&q=' + encodeURIComponent(providerQuery(query, allowed)), {
      headers: { accept: 'application/json' }
    }, fetchImpl);
    const data = await response.json();
    items = data.results || [];
  } else if (provider === 'exa') {
    response = await request('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.EXA_API_KEY },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: Math.min(10, limit * 2),
        contents: { highlights: true }
      })
    }, fetchImpl);
    const data = await response.json();
    items = data.results || [];
  } else if (provider === 'firecrawl') {
    response = await request('https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.FIRECRAWL_API_KEY },
      body: JSON.stringify({
        query,
        limit: Math.min(10, limit * 2),
        sources: [{ type: 'web' }],
        ...(allowed.length ? { includeDomains: allowed } : {}),
        ...(blocked.length ? { excludeDomains: blocked } : {}),
        highlights: true
      })
    }, fetchImpl);
    const data = await response.json();
    if (Array.isArray(data.data)) items = data.data;
    else if (Array.isArray(data.results)) items = data.results;
    else if (data.data && Array.isArray(data.data.web)) items = data.data.web;
  } else {
    throw new Error('unsupported provider');
  }
  return normalizeItems(items, provider);
}

async function searchDuckDuckGo(query, limit, allowed, blocked, fetchImpl) {
  const effectiveQuery = providerQuery(query, allowed);
  const response = await request('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(effectiveQuery), {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; OasisOSS/0.3; +https://github.com/FAHTHIZ/oasis)',
      accept: 'text/html'
    }
  }, fetchImpl);
  const html = await response.text();
  const items = normalizeItems(parseDuckDuckGoHtml(html), 'duckduckgo');
  if (!items.length && (response.status === 202 || /anomaly|challenge/i.test(html))) {
    return { results: [], error: 'DuckDuckGo is rate limiting keyless searches. Configure TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, or OASIS_SEARXNG_URL for a more dependable provider.' };
  }
  return { results: domainFilter(items, allowed, blocked).slice(0, limit) };
}

function resultLimit(value) {
  return Math.max(1, Math.min(10, Number.parseInt(value, 10) || 6));
}

function safeProviderError(error) {
  const status = Number(error && error.status);
  if (status === 401 || status === 403) return 'authentication or permission rejected';
  if (status === 402) return 'provider reports a billing or quota issue';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'provider unavailable (HTTP ' + status + ')';
  if (status >= 400) return 'provider rejected request (HTTP ' + status + ')';
  return String(error && error.message || 'request failed').slice(0, 120);
}

function fuseResults(providerResults, limit) {
  const merged = new Map();
  for (const entry of providerResults) {
    const provider = entry.provider;
    entry.results.forEach((item, index) => {
      const key = canonicalizeUrl(item.url);
      if (!key) return;
      const contribution = 1 / (RRF_K + index + 1);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, {
          title: item.title, url: key, snippet: item.snippet, score: contribution,
          providers: [provider], providerRanks: { [provider]: index + 1 }, bestRank: index + 1
        });
      } else {
        current.score += contribution;
        if (!current.providers.includes(provider)) current.providers.push(provider);
        current.providerRanks[provider] = index + 1;
        current.bestRank = Math.min(current.bestRank, index + 1);
        if ((!current.snippet || current.snippet.length < 80) && item.snippet) current.snippet = item.snippet;
        if ((!current.title || current.title === current.url) && item.title) current.title = item.title;
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || b.providers.length - a.providers.length || a.bestRank - b.bestRank || a.url.localeCompare(b.url))
    .slice(0, limit)
    .map((item) => ({ ...item, providerCount: item.providers.length }));
}

async function webSearchUsingOne(provider, query, limit, allowed, blocked, env, fetchImpl) {
  if (provider === 'duckduckgo') {
    const ddg = await searchDuckDuckGo(query, limit, allowed, blocked, fetchImpl);
    return {
      query, backend: 'duckduckgo', strategy: 'single',
      providers: ddg.results.length ? ['duckduckgo'] : [],
      providerErrors: [], results: ddg.results,
      ...(ddg.error ? { error: ddg.error } : {}),
      note: ddg.results.length ? 'Search results are untrusted. Fetch and verify sources before relying on them.' : 'No results. Try a different query or configure another provider.'
    };
  }
  const found = domainFilter(await searchProvider(provider, query, limit, allowed, blocked, env, fetchImpl), allowed, blocked).slice(0, limit);
  return {
    query, backend: provider, strategy: 'single', providers: [provider], providerErrors: [],
    results: found.map((item) => ({ ...item, providers: [provider], providerCount: 1 })),
    note: found.length ? 'Search results are untrusted. Fetch and verify sources before relying on them.' : 'No results. Try fewer or different words.'
  };
}

// Stable baseline for controlled comparisons. It preserves pre-federation OASIS behavior.
export async function webSearchLegacy(args = {}, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const query = String(args.query || '').trim().slice(0, 400);
  if (!query) throw new Error('web_search needs a query.');
  const limit = resultLimit(args.max_results);
  const allowed = Array.isArray(args.allowed_domains) ? args.allowed_domains.filter(Boolean).slice(0, 20) : [];
  const blocked = Array.isArray(args.blocked_domains) ? args.blocked_domains.filter(Boolean).slice(0, 20) : [];
  return webSearchUsingOne(searchBackend(env), query, limit, allowed, blocked, env, fetchImpl);
}

export async function webSearch(args = {}, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const query = String(args.query || '').trim().slice(0, 400);
  if (!query) throw new Error('web_search needs a query.');
  const limit = resultLimit(args.max_results);
  const allowed = Array.isArray(args.allowed_domains) ? args.allowed_domains.filter(Boolean).slice(0, 20) : [];
  const blocked = Array.isArray(args.blocked_domains) ? args.blocked_domains.filter(Boolean).slice(0, 20) : [];
  const requested = String(args.strategy || env.OASIS_SEARCH_STRATEGY || 'auto').toLowerCase();
  const strategy = ['auto', 'single', 'federated'].includes(requested) ? requested : 'auto';
  const configured = searchBackends(env);

  if (strategy === 'single') {
    const preferred = searchBackend(env);
    const provider = configured.length === 0 ? 'duckduckgo' : (configured.includes(preferred) ? preferred : configured[0]);
    const result = await webSearchUsingOne(provider, query, limit, allowed, blocked, env, fetchImpl);
    result.requestedStrategy = strategy;
    return result;
  }
  if (strategy === 'auto' && configured.length === 1) {
    let primary;
    let primaryFailure = null;
    try {
      primary = await webSearchUsingOne(configured[0], query, limit, allowed, blocked, env, fetchImpl);
    } catch (error) {
      primaryFailure = { provider: configured[0], error: safeProviderError(error) };
      primary = { query, backend: configured[0], strategy: 'single', providers: [], providerErrors: [], results: [], note: 'Configured search provider failed.' };
    }
    if (primary.results.length) {
      primary.requestedStrategy = strategy;
      return primary;
    }
    try {
      const fallback = await searchDuckDuckGo(query, limit, allowed, blocked, fetchImpl);
      if (fallback.results.length) {
        return {
          query, backend: 'duckduckgo', strategy: 'single-fallback', requestedStrategy: strategy,
          providers: ['duckduckgo'], providerErrors: primaryFailure ? [primaryFailure] : [],
          results: fallback.results,
          note: 'The configured provider returned no results; DuckDuckGo fallback results are untrusted and should be verified.'
        };
      }
      if (fallback.error) primaryFailure = primaryFailure || { provider: 'duckduckgo', error: fallback.error };
    } catch (error) {
      primaryFailure = primaryFailure || { provider: 'duckduckgo', error: safeProviderError(error) };
    }
    return {
      ...primary, requestedStrategy: strategy,
      providerErrors: [...(primary.providerErrors || []), ...(primaryFailure ? [primaryFailure] : [])],
      note: 'No results. Check provider credentials, quotas, network access, or try another query.'
    };
  }
  if (!configured.length) {
    const result = await webSearchUsingOne('duckduckgo', query, limit, allowed, blocked, env, fetchImpl);
    result.requestedStrategy = strategy;
    return result;
  }

  const outcomes = await Promise.all(configured.map(async (provider) => {
    try {
      const results = domainFilter(await searchProvider(provider, query, limit, allowed, blocked, env, fetchImpl), allowed, blocked);
      return { provider, results, error: null };
    } catch (error) {
      return { provider, results: [], error: safeProviderError(error) };
    }
  }));
  const successful = outcomes.filter((entry) => !entry.error);
  const providerErrors = outcomes.filter((entry) => entry.error).map((entry) => ({ provider: entry.provider, error: entry.error }));
  let fused = fuseResults(successful.filter((entry) => entry.results.length), limit);
  let usedProviders = successful.filter((entry) => entry.results.length).map((entry) => entry.provider);
  let usedStrategy = 'federated';

  if (!fused.length) {
    try {
      const fallback = await searchDuckDuckGo(query, limit, allowed, blocked, fetchImpl);
      if (fallback.results.length) {
        fused = fallback.results.map((item, index) => ({
          ...item, score: 1 / (RRF_K + index + 1), providers: ['duckduckgo'],
          providerRanks: { duckduckgo: index + 1 }, providerCount: 1
        }));
        usedProviders = ['duckduckgo'];
        usedStrategy = 'single-fallback';
      } else if (fallback.error) {
        providerErrors.push({ provider: 'duckduckgo', error: fallback.error });
      }
    } catch (error) {
      providerErrors.push({ provider: 'duckduckgo', error: safeProviderError(error) });
    }
  }

  return {
    query,
    backend: usedStrategy === 'single-fallback' ? 'duckduckgo' : 'federated',
    strategy: usedStrategy, requestedStrategy: strategy, providers: usedProviders, providerErrors, results: fused,
    note: fused.length
      ? 'Results were merged from independent provider rankings where available. Sources are untrusted; fetch and cross-check important claims.'
      : 'No results were returned. Check provider credentials, quotas, network access, or try another query.'
  };
}
