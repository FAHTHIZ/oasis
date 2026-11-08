// The sites a web tool call reaches (the fetched host, or the configured search
// providers' hosts), so each new site is approved once per session.
import { searchBackends, searchBackend } from './web-search.mjs';

export const SEARCH_PROVIDER_HOSTS = {
  duckduckgo: 'html.duckduckgo.com',
  tavily: 'api.tavily.com',
  brave: 'api.search.brave.com',
  exa: 'api.exa.ai',
  firecrawl: 'api.firecrawl.dev'
};

export function webSearchHosts(args, env) {
  const configured = searchBackends(env);
  const strategy = String(args.strategy || env.OASIS_SEARCH_STRATEGY || 'auto').toLowerCase();
  let providers;
  if (strategy === 'single') {
    const preferred = searchBackend(env);
    providers = [configured.length ? (configured.includes(preferred) ? preferred : configured[0]) : 'duckduckgo'];
  } else {
    providers = configured.length ? [...configured, 'duckduckgo'] : ['duckduckgo'];
  }
  return [...new Set(providers.map((provider) => {
    if (provider === 'searxng') {
      try { return new URL(String(env.OASIS_SEARXNG_URL)).hostname.toLowerCase(); }
      catch { return 'configured SearXNG endpoint'; }
    }
    return SEARCH_PROVIDER_HOSTS[provider] || provider;
  }))];
}

export function webAccessSites(name, args, env) {
  if (name === 'fetch_url') {
    try {
      const host = new URL(String(args.url || '')).hostname.toLowerCase();
      return host ? [host] : [];
    } catch { return []; }
  }
  return name === 'web_search' ? webSearchHosts(args, env) : [];
}
