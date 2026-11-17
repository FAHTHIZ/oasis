import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolSources, MAX_SOURCES } from '../src/tool-sources.mjs';

test('web_search results become sources, http(s) only, deduplicated and capped', () => {
  const results = [
    { title: 'Node.js 22', url: 'https://nodejs.org/en/blog/release/v22.0.0' },
    { title: 'dup', url: 'https://nodejs.org/en/blog/release/v22.0.0' },
    { title: 'bad', url: 'javascript:alert(1)' },
    { title: '  Spaced\n title ', url: 'https://user:pw@example.com/x' },
    ...Array.from({ length: 12 }, (_, i) => ({ title: 'r' + i, url: 'https://e' + i + '.com/' }))
  ];
  const sources = toolSources('web_search', { query: 'node' }, { results });
  assert.equal(sources.length, MAX_SOURCES);
  assert.deepEqual(sources[0], { title: 'Node.js 22', url: 'https://nodejs.org/en/blog/release/v22.0.0' });
  assert.deepEqual(sources[1], { title: 'Spaced title', url: 'https://example.com/x' });
});

test('fetch_url gives its page; errors give nothing; MCP citations count', () => {
  assert.deepEqual(toolSources('fetch_url', { url: 'https://a.dev/p' }, { url: 'https://a.dev/p', title: 'A page' }), [{ url: 'https://a.dev/p', title: 'A page' }]);
  assert.deepEqual(toolSources('fetch_url', { url: 'https://a.dev/p' }, { error: 'nope' }), []);
  assert.deepEqual(toolSources('mcp__perplexity__search', {}, { citations: ['https://b.org/'] }), [{ url: 'https://b.org/' }]);
  assert.deepEqual(toolSources('read_file', {}, { content: 'x' }), []);
});
