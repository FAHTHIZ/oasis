// Markdown renderer for agent replies: marked (MIT) parses CommonMark + GFM;
// the renderer below keeps the output safe. Raw HTML is shown as text, links
// must be http(s) or mailto, and images become links (no remote loads).

import { Marked } from 'marked';

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeHref(url) {
  const value = String(url || '').trim();
  return /^(https?:|mailto:)/i.test(value) ? escapeHtml(value) : null;
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) { return escapeHtml(text); },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      return safe ? '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    },
    image({ href, text }) {
      const safe = safeHref(href);
      return safe ? '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text || href) + '</a>' : escapeHtml(text || '');
    },
    heading({ tokens, depth }) {
      const level = Math.min(depth + 1, 4);
      return '<h' + level + '>' + this.parser.parseInline(tokens) + '</h' + level + '>';
    },
    code({ text, lang }) {
      const language = String(lang || '').match(/^[\w+#.-]*/)[0];
      return '<pre><button class="copy" type="button">Copy</button><code' + (language ? ' data-lang="' + escapeHtml(language) + '"' : '') + '>' + escapeHtml(text) + '</code></pre>';
    },
    checkbox({ checked }) { return checked ? '☑ ' : '☐ '; }
  }
});

export function renderMarkdown(source) {
  return marked.parse(String(source || '').replace(/\r\n/g, '\n'), { async: false });
}

/**
 * Streaming support: split text into blocks that can no longer change
 * (every block before the last one) and the open tail. A streaming reply
 * renders each stable block once and re-renders only the tail, so earlier
 * paragraphs, code blocks and selections stay put while text arrives.
 * Splits fall on block boundaries, so rendering the parts one by one gives
 * the same HTML as rendering the whole text. Text with reference-style link
 * definitions (which reach across blocks) is never split.
 */
export function splitStableMarkdown(source) {
  const text = String(source || '').replace(/\r\n/g, '\n');
  let tokens;
  try { tokens = marked.lexer(text); } catch { return { stable: '', rest: text }; }
  if (tokens.links && Object.keys(tokens.links).length) return { stable: '', rest: text };
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last].type === 'space') last--;
  if (last <= 0) return { stable: '', rest: text };
  const stable = tokens.slice(0, last).map((token) => token.raw).join('');
  // The lexer's raw text always adds up to the source; anything else
  // (a marked change) falls back to rendering the whole text.
  if (!stable || !text.startsWith(stable)) return { stable: '', rest: text };
  return { stable, rest: text.slice(stable.length) };
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('pre .copy');
    if (!button) return;
    const code = button.parentElement.querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(() => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1200); }, () => {});
  });
}
