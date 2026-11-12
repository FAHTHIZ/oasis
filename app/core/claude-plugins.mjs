// Claude Code plugins installed on the computer running `oasis web`, as shown
// in the app's Plugins sheet. Pure helpers: no DOM, no network.

// The most-installed plugins in Anthropic's official marketplace (late 2026),
// listed first when the search box is empty.
const POPULAR_PLUGINS = [
  'frontend-design', 'superpowers', 'code-review', 'context7', 'code-simplifier', 'playwright',
  'github', 'claude-md-management', 'feature-dev', 'security-guidance', 'commit-commands',
  'pr-review-toolkit', 'typescript-lsp', 'ralph-loop', 'hookify', 'skill-creator'
];

export const OFFICIAL_MARKETPLACE = 'anthropics/claude-plugins-official';

/**
 * Marketplace plugins matching `query`, best first. With no query, popular
 * plugins come first. Each result: { id, name, marketplace, description, installed }.
 */
export function searchMarketplace(overview, query = '', limit = 24) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const items = [];
  for (const market of (overview && Array.isArray(overview.marketplaces) ? overview.marketplaces : [])) {
    for (const plugin of market.plugins || []) {
      const name = String(plugin.name || '');
      const text = (name + ' ' + (plugin.description || '') + ' ' + (plugin.category || '')).toLowerCase();
      if (words.length && !words.every((word) => text.includes(word))) continue;
      const popular = POPULAR_PLUGINS.indexOf(name);
      let score = popular >= 0 ? 100 - popular : 0;
      if (words.length) score += words.reduce((sum, word) => sum + (name.toLowerCase() === word ? 200 : name.toLowerCase().includes(word) ? 50 : 0), 0);
      items.push({ id: name.toLowerCase() + '@' + market.name, name, marketplace: market.name, description: String(plugin.description || ''), installed: Boolean(plugin.installed), score });
    }
  }
  items.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return items.slice(0, Math.max(0, limit)).map(({ score, ...item }) => item);
}

export function marketplaceCount(overview) {
  return (overview && Array.isArray(overview.marketplaces) ? overview.marketplaces : []).reduce((sum, market) => sum + (market.plugins || []).length, 0);
}
