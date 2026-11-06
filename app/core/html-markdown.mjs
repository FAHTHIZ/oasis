// Browser HTML -> Markdown for the app's fetch_url tool: the browser's own
// DOMParser, a landmark-based main-content pick, and turndown (MIT) with the GFM
// plugin for tables and strikethrough. The CLI and runtime use Defuddle instead
// (src/html-markdown.mjs), which needs a Node DOM and a worker thread.
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const UNSAFE_URL = /^\s*(?:javascript|vbscript|data|file):/i;
const CLUTTER = 'script, style, noscript, template, svg, iframe, object, embed, form, nav, header, footer, aside, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';

let service = null;
function turndown() {
  if (service) return service;
  service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  service.use(gfm);
  // Fences longer than any backtick run inside, with the language when the
  // markup names one (language-js, lang-js, highlight-source-js).
  service.addRule('fencedCode', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const code = node.querySelector('code') || node;
      const text = code.textContent.replace(/\n$/, '');
      const match = ((code.getAttribute('class') || '') + ' ' + (node.getAttribute('class') || '')).match(/(?:language|lang|highlight-source)-([\w+#-]+)/);
      const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
      const fence = '`'.repeat(longest + 1);
      return '\n\n' + fence + (match ? match[1] : '') + '\n' + text + '\n' + fence + '\n\n';
    }
  });
  return service;
}

export function htmlToMarkdown(html, options = {}) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const title = (doc.title || '').replace(/\s+/g, ' ').trim();
  for (const element of doc.querySelectorAll(CLUTTER)) element.remove();
  for (const element of doc.querySelectorAll('[style]')) {
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(element.getAttribute('style') || '')) element.remove();
  }
  for (const element of doc.querySelectorAll('[href], [src]')) {
    for (const attribute of ['href', 'src']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (UNSAFE_URL.test(value)) { element.removeAttribute(attribute); continue; }
      if (options.url) { try { element.setAttribute(attribute, new URL(value, options.url).href); } catch {} }
    }
  }
  const root = doc.querySelector('main article, article, main, [role="main"]') || doc.body;
  const markdown = root ? turndown().turndown(root).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() : '';
  return { title, markdown, extracted: root !== doc.body };
}
