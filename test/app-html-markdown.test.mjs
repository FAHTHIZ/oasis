import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { htmlToMarkdown } from '../app/core/html-markdown.mjs';

globalThis.DOMParser ??= DOMParser;
// Browsers implement HTMLTableElement.rows (the GFM plugin reads it); linkedom does not.
const tableProto = Object.getPrototypeOf(new DOMParser().parseFromString('<table></table>', 'text/html').querySelector('table'));
if (!('rows' in tableProto)) Object.defineProperty(tableProto, 'rows', { get() { return [...this.querySelectorAll('tr')]; } });

test('the browser app converts pages with turndown: main content, GFM tables, safe links, long fences', () => {
  const html = `<!doctype html><html><head><title>Guide</title><script>bad()</script></head><body>
<nav><a href="/">Home</a></nav><main><h1>Install</h1><p>Run <code>npm i</code>, then read <a href="../api">the API</a> or <a href="javascript:alert(1)">this</a>.</p>
<pre><code class="language-sh">echo \`\`\`
</code></pre><table><thead><tr><th>OS</th><th>Steps</th></tr></thead><tbody><tr><td>Linux</td><td>apt</td></tr></tbody></table>
<ul><li>one</li><li>two</li></ul><p hidden>secret</p><p style="display: none">also secret</p></main><footer>Copyright</footer></body></html>`;
  const page = htmlToMarkdown(html, { url: 'https://docs.example.com/guide/install' });
  assert.equal(page.title, 'Guide');
  assert.equal(page.extracted, true);
  const md = page.markdown;
  assert.match(md, /^# Install$/m);
  assert.match(md, /\[the API\]\(https:\/\/docs\.example\.com\/api\)/);
  assert.doesNotMatch(md, /javascript:|bad\(\)|secret|Home|Copyright/);
  assert.match(md, /````sh\necho ```\n````/);
  assert.match(md, /\| OS \| Steps \|\n\| --- \| --- \|\n\| Linux \| apt \|/);
  assert.match(md, /^-\s+one\n-\s+two$/m);
});
