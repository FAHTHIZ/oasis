// The web pages a step looked at, for source chips in the activity feed
// (Perplexity shows each search's sources as favicon + site chips): a
// web_search's results, a fetch_url's page, and any tool (an MCP search
// server, say) whose result lists { url, title } items under results,
// sources or citations. Only http(s) links, at most MAX_SOURCES, each
// title cut to one short line.

export const MAX_SOURCES = 8;

function clean(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    // Credentials in a link are never shown.
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().slice(0, 500);
  } catch { return ''; }
}

function oneLine(text, max = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

export function toolSources(name, args = {}, result = null) {
  const out = [];
  const seen = new Set();
  const add = (url, title) => {
    const link = clean(url);
    if (!link || seen.has(link) || out.length >= MAX_SOURCES) return;
    seen.add(link);
    out.push({ url: link, ...(oneLine(title) ? { title: oneLine(title) } : {}) });
  };
  if (!result || typeof result !== 'object' || result.error) return out;
  if (name === 'fetch_url') { add(result.url || (args && args.url), result.title); return out; }
  for (const key of ['results', 'sources', 'citations']) {
    const list = Array.isArray(result[key]) ? result[key] : [];
    for (const item of list) {
      if (typeof item === 'string') add(item, '');
      else if (item && typeof item === 'object') add(item.url || item.link || item.href, item.title || item.name);
    }
  }
  return out;
}
