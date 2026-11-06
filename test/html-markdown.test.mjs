import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, decodeEntities } from '../src/html-markdown.mjs';
import { fetchPublicUrl } from '../src/public-fetch.mjs';

const PAGE = `<!doctype html><html><head><title>Fetch API &mdash; Docs</title>
<meta name="description" content="How to fetch"><style>.x{color:red}</style>
<script>var html = "</div><p>not content</p>";</script></head>
<body><header class="site-header"><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav></header>
<div class="sidebar"><ul><li><a href="/a">Sidebar A</a></li><li><a href="/b">Sidebar B</a></li></ul></div>
<main><article><h1>Using the Fetch API <a class="headerlink" href="#top">¶</a></h1>
<p>The <code>fetch()</code> method starts fetching a resource from the network, returning a promise that is fulfilled once the response is available. See <a href="../Response">Response</a> &amp; <a href="javascript:alert(1)">this</a>.</p>
<h2>Example</h2><pre><code class="language-js">const r = await fetch(url);
if (r.status &lt; 300) console.log(\`\`\`);</code></pre>
<ul><li>First <strong>bold</strong> item<ul><li>nested</li></ul></li><li>Second <em>item</em></li></ul>
<ol start="3"><li>three<li>four</ol>
<table><thead><tr><th>Option</th><th>Default</th></tr></thead><tbody><tr><td>cache</td><td>default</td></tr><tr><td>mode | x</td><td>cors</td></tr></tbody></table>
<blockquote><p>Quoted text.</p></blockquote><img src="pic.png" alt="Diagram">
<div hidden>secret hidden text</div><p style="display:none">also hidden</p>
</article></main><footer>Copyright <a href="/privacy">Privacy</a></footer>
<div class="cookie-banner">Accept cookies</div></body></html>`;

test('htmlToMarkdown extracts the main content and renders Markdown structure', async () => {
  const result = await htmlToMarkdown(PAGE, { url: 'https://docs.example.org/en/api/fetch/' });
  const md = result.markdown;
  // Defuddle drops the site-name suffix from the page title.
  assert.equal(result.title, 'Fetch API');
  assert.equal(result.description, 'How to fetch');
  assert.equal(result.extracted, true);
  assert.match(md, /^## Using the Fetch API$/m, 'heading kept (below the page title), permalink anchor dropped');
  assert.match(md, /The `fetch\(\)` method/);
  assert.match(md, /\[Response\]\(https:\/\/docs\.example\.org\/en\/api\/Response\)/, 'relative links resolve against the page URL');
  assert.doesNotMatch(md, /javascript:/i, 'script URLs are never emitted');
  assert.match(md, /& this\./);
  assert.match(md, /````js\nconst r = await fetch\(url\);\nif \(r\.status < 300\) console\.log\(```\);\n````/, 'code fence is longer than any backtick run inside');
  assert.match(md, /^- First \*\*bold\*\* item\n\s+- nested\n- Second \*item\*$/m, 'short lists are content, not metadata');
  assert.match(md, /^3\. three\n4\. four$/m);
  assert.match(md, /\| Option \| Default \|\n\| --- \| --- \|\n\| cache \| default \|\n\| mode \\\| x \| cors \|/);
  assert.match(md, /^> Quoted text\.$/m);
  assert.match(md, /!\[Diagram\]\(https:\/\/docs\.example\.org\/en\/api\/fetch\/pic\.png\)/);
  for (const junk of ['Home', 'Sidebar A', 'Copyright', 'Accept cookies', 'not content', 'color:red', 'secret hidden', 'also hidden']) {
    assert.ok(!md.includes(junk), 'boilerplate removed: ' + junk);
  }
});

test('a header-classed block that holds the page title and intro is kept', async () => {
  const html = `<body><nav>${'<a href="/x">Nav</a>'.repeat(5)}</nav><main><div class="layout__header page-header"><h1>Real Title</h1><p>Intro paragraph that matters for the reader.</p></div><section><p>${'Body text, with commas, and more words here. '.repeat(10)}</p></section></main></body>`;
  const result = await htmlToMarkdown(html);
  assert.equal(result.title, 'Real Title');
  assert.match(result.markdown, /Intro paragraph/);
  assert.ok(!result.markdown.includes('Nav'));
});

test('prose next to a link list survives and link-only pages keep their links', async () => {
  const languages = '<ul class="langs">' + Array.from({ length: 30 }, (_, i) => `<li><a href="/l${i}">Language ${i}</a></li>`).join('') + '</ul>';
  const prose = '<p>' + 'PageRank works by counting the number and quality of links to a page, to estimate importance. '.repeat(8) + '</p>';
  const md = (await htmlToMarkdown(`<body><main><h1>PageRank</h1>${languages}${prose}</main></body>`)).markdown;
  assert.match(md, /counting the number and quality/);
  // A pure index page keeps its links rather than coming back empty.
  const index = (await htmlToMarkdown('<body><main><h1>Index</h1>' + languages + '</main></body>')).markdown;
  assert.match(index, /\[Language 7\]\(\/l7\)/);
});

test('Readability scoring finds the article when there are no landmarks', async () => {
  const nav = '<div id="menu">' + Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join(' | ') + '</div>';
  const article = '<div class="post-body">' + Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i}: the scoring awards points for length, commas, and paragraph count, so real prose wins.</p>`).join('') + '</div>';
  const footer = '<div class="foot">Terms | Privacy | Contact us anytime</div>';
  const result = await htmlToMarkdown(`<html><body><div class="wrap">${nav}${article}${footer}</div></body></html>`);
  assert.match(result.markdown, /^Paragraph 0: the scoring/);
  assert.ok(!result.markdown.includes('Page 3'));
  assert.ok(!result.markdown.includes('Terms'));
});

test('full-page mode keeps everything outside scripts and styles', async () => {
  const md = (await htmlToMarkdown(PAGE, { extract: false })).markdown;
  assert.match(md, /Copyright/);
  assert.match(md, /Sidebar A/);
  for (const junk of ['not content', 'color:red', 'secret hidden', 'also hidden']) assert.ok(!md.includes(junk), 'still removed: ' + junk);
});

test('decodeEntities handles named, decimal and hex references safely', async () => {
  assert.equal(decodeEntities('a &lt;b&gt; &amp;amp; &#65;&#x42; &hellip; &unknown; &#0; &#xD800;'), 'a <b> &amp; AB … &unknown; \ufffd \ufffd');
});

test('parser tolerates malformed HTML and stays fast on hostile input', async () => {
  assert.match((await htmlToMarkdown('<p>one<p>two</div><li>x<td>y</td><a href="x>broken', { extract: false })).markdown, /one[\s\S]*two/);
  const started = Date.now();
  await htmlToMarkdown('<div>'.repeat(20000) + 'deep' + '<a href="'.repeat(5000) + '<'.repeat(100000) + '<p '.repeat(50000));
  await htmlToMarkdown('<p>' + 'word '.repeat(200000));
  assert.ok(Date.now() - started < 8000, 'conversion finished in ' + (Date.now() - started) + 'ms');
});

function fakeResponse(body, type = 'text/html; charset=utf-8') {
  return async () => ({ status: 200, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) }, body });
}

test('fetch_url returns Markdown and pages long content with start_index', async () => {
  const paragraphs = Array.from({ length: 400 }, (_, i) => `<p>Paragraph number ${i}, with enough words to make the page long, and commas.</p>`).join('');
  const html = `<html><head><title>Long Page</title></head><body><nav><a href="/">Home</a></nav><article><h1>Long Page</h1>${paragraphs}</article></body></html>`;
  const first = await fetchPublicUrl('https://93.184.216.34/long', { requestImpl: fakeResponse(html), maxLength: 2000 });
  assert.equal(first.title, 'Long Page');
  assert.equal(first.format, 'markdown (main content)');
  assert.match(first.content, /^# Long Page\n\nParagraph number 0,/);
  assert.equal(first.truncated, true);
  assert.ok(first.content.length <= 2000);
  assert.ok(first.content.endsWith('commas.'), 'page breaks on a paragraph boundary');
  assert.ok(first.nextStartIndex > 0 && first.totalLength > first.nextStartIndex);
  const second = await fetchPublicUrl('https://93.184.216.34/long', { requestImpl: fakeResponse(html), maxLength: 2000, startIndex: first.nextStartIndex });
  assert.equal(second.startIndex, first.nextStartIndex);
  assert.match(second.content.trimStart(), /^Paragraph number \d+,/);
  assert.ok(!first.content.includes(second.content.trim().split('\n')[0]), 'second page continues where the first ended');
  const past = await fetchPublicUrl('https://93.184.216.34/long', { requestImpl: fakeResponse(html), startIndex: 10_000_000 });
  assert.match(past.error, /past the end/);
  const raw = await fetchPublicUrl('https://93.184.216.34/long', { requestImpl: fakeResponse(html), raw: true, maxLength: 600 });
  assert.match(raw.content, /^<html><head><title>/);
  const plain = await fetchPublicUrl('https://93.184.216.34/notes.txt', { requestImpl: fakeResponse('just *text*', 'text/plain') });
  assert.equal(plain.content, 'just *text*');
  assert.equal(plain.format, undefined);
});

test('character references use the full HTML5 table, and attributes follow the attribute rules', async () => {
  assert.equal(decodeEntities('&Lambda; &lang;a&rang; &bigstar; &nexist; &cent a&nbsp;b'), 'Λ ⟨a⟩ ★ ∄ ¢ a b');
  // In an attribute, `&copy=` is not a reference (HTML spec), so query strings survive.
  const { markdown } = await htmlToMarkdown('<p><a href="/s?a=1&copy=2&amp;b=3">x</a></p>', { url: 'https://example.com/', extract: false });
  assert.equal(markdown, '[x](https://example.com/s?a=1&copy=2&b=3)');
});

test('pathological pages are bounded: deep nesting is flattened and slow conversions fall back to text', async () => {
  let started = performance.now();
  const deep = await htmlToMarkdown('<div>'.repeat(20000) + 'deep text' + '</div>'.repeat(20000));
  assert.match(deep.markdown, /deep text/);
  assert.ok(performance.now() - started < 12000, 'deep nesting took ' + Math.round(performance.now() - started) + ' ms');
  // Thousands of sibling link blocks make extraction superlinear; the worker is
  // stopped at the deadline and the text still comes back.
  const wide = '<html><body><main>' + '<div><span><a href="/a">link</a> some, text here</span></div>'.repeat(30000) + '</main></body></html>';
  started = performance.now();
  const result = await htmlToMarkdown(wide, { timeoutMs: 1500 });
  const elapsed = performance.now() - started;
  assert.match(result.degraded, /timed out after 1500 ms/);
  assert.match(result.markdown, /^link some, text here\n/);
  assert.ok(elapsed < 12000, 'fallback took ' + Math.round(elapsed) + ' ms');
  // The converter restarts for the next page.
  assert.match((await htmlToMarkdown('<article><p>Back to normal, with a full sentence of prose here.</p></article>')).markdown, /Back to normal/);
});

test('site extractors never reach the network during conversion', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('blocked'); };
  try {
    const page = '<html><head><title>Video - YouTube</title><meta property="og:title" content="Video"></head><body><div id="description">A video description with enough words to count as content.</div></body></html>';
    await htmlToMarkdown(page, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', inline: true });
    await htmlToMarkdown('<html><body><shreddit-post><p>post body text here</p></shreddit-post></body></html>', { url: 'https://www.reddit.com/r/x/comments/abc/t/', inline: true });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls, []);
});
