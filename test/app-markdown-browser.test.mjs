// The web app's Markdown renderer in a real Chromium: highlight.js and DOMPurify
// load through the import map, code is coloured, and markup a renderer bug might
// let through is removed. Skipped when no Chrome is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, Browser } from '../src/cdp.mjs';
import { startAppServer } from '../src/app-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = findChrome(process.env);

test('app markdown highlights code and sanitizes HTML in the browser', { skip: chrome ? false : 'no Chrome/Chromium installed', timeout: 120000 }, async (t) => {
  const app = await startAppServer({ root, port: 0 });
  const browser = await Browser.launch({ env: { ...process.env, OASIS_CHROME_HEADLESS: '1' }, executable: chrome });
  t.after(async () => { await browser.close(); app.close(); });
  const base = 'http://127.0.0.1:' + app.address().port + '/app/';
  const page = await browser.newPage('about:blank');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: base });
  const evaluate = async (expression) => {
    const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text);
    return result.result.value;
  };
  // Bare imports resolve only once the page's import map is in: wait for the
  // page itself, not a fixed second (a slow CI runner needed longer).
  for (let i = 0; i < 300; i++) {
    const ready = await evaluate("location.pathname === '/app/' && document.readyState === 'complete' && Boolean(document.querySelector('script[type=importmap]'))").catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const out = await evaluate(`(async () => {
    const m = await import('/app/markdown.mjs');
    return {
      code: m.renderMarkdown('\`\`\`python\\ndef f():\\n    return "x"\\n\`\`\`'),
      xss: m.renderMarkdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [ok](https://a.b/)'),
      table: m.renderMarkdown('| a | b |\\n|:-|-:|\\n| 1 | 2 |\\n\\n1. x\\n2. y\\n\\n> q\\n\\n~~d~~ \`c\`'),
      stream: m.renderMarkdown('one\\n\\ntwo') === m.renderMarkdown('one\\n\\n') + m.renderMarkdown('two')
    };
  })()`);
  assert.match(out.code, /<span class="hljs-keyword">def<\/span> <span class="hljs-title function_">f<\/span>/);
  assert.match(out.code, /^<pre><button class="copy" type="button">Copy<\/button><code data-lang="python" class="hljs">/);
  assert.match(out.code, /<span class="hljs-string">"x"<\/span>/);
  assert.ok(!out.xss.includes('<img') && !/href="javascript/i.test(out.xss), out.xss);
  assert.match(out.xss, /<a href="https:\/\/a\.b\/" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(out.table, /<th align="left">a<\/th>/);
  assert.match(out.table, /<td align="right">2<\/td>/);
  assert.match(out.table, /<ol>/);
  assert.match(out.table, /<blockquote>/);
  assert.match(out.table, /<del>d<\/del>/);
  assert.equal(out.stream, true);
});
