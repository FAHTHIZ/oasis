// HTML -> Markdown conversion with Readability-style
// main-content extraction, used by fetch_url and /web.
//
// The approach follows Mozilla Readability and the reference MCP "fetch"
// server: drop scripts, navigation, sidebars and other boilerplate, choose the
// element that holds the article text, then render it as Markdown so headings,
// links, lists, tables and code blocks survive for the model. The scanner is a
// linear hand-written tokenizer (no backtracking regexes over untrusted HTML).

import { decodeHTML, decodeHTMLAttribute } from 'entities';

const MAX_DEPTH = 256;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'noembed', 'noframes']);
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'noembed', 'noframes', 'head', 'link', 'meta', 'base', 'button', 'select', 'input', 'textarea', 'form', 'dialog', 'video', 'audio', 'picture', 'map']);
const BOILERPLATE_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'menu']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'caption']);
// Opening one of these implicitly closes an open element of the listed kinds.
const AUTO_CLOSE = {
  p: ['p'], li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'],
  thead: ['tbody', 'tfoot', 'tr', 'td', 'th'], tbody: ['thead', 'tbody', 'tr', 'td', 'th'], tfoot: ['thead', 'tbody', 'tr', 'td', 'th'], option: ['option']
};
const P_CLOSERS = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'pre', 'section', 'table', 'ul', 'figure']);
// Readability's heuristics, trimmed.
const UNLIKELY = /(?:^|[\s_-])(?:banner|breadcrumbs?|combx|comment|community|cookie|consent|disqus|extra|foot|footer|header|legends|menu|related|remark|replies|rss|share|sharing|shoutbox|sidebar|skyscraper|social|sponsor|ad-break|ads?|advert|agegate|pagination|pager|popup|modal|newsletter|subscribe|promo|toc-mobile|skip-link|navbar|nav|masthead|signup)(?:$|[\s_-])/i;
const MAYBE = /and|article|body|column|content|main|shadow|post|entry|markdown|prose|docs?/i;
const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story|markdown|prose|docs?-?content|documentation/i;
const NEGATIVE = /hidden|^hid$|banner|combx|comment|contact|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|nav|menu/i;

// Character references are decoded by `entities` (the full HTML5 table, with the
// spec's legacy no-semicolon forms). No-break and fixed-width spaces become plain
// spaces and soft hyphens vanish, so Markdown wraps and searches as plain text.
const SPACES = /[\u00a0\u2002\u2003\u2009]/g;
const tidy = (text) => text.replace(SPACES, ' ').replace(/\u00ad/g, '');

export function decodeEntities(text) {
  const value = String(text || '');
  return value.includes('&') ? tidy(decodeHTML(value)) : value;
}

function decodeAttribute(text) {
  const value = String(text || '');
  return value.includes('&') ? tidy(decodeHTMLAttribute(value)) : value;
}

function parseAttributes(source) {
  const attrs = {};
  let i = 0;
  const n = source.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(source[i])) i += 1;
    const start = i;
    while (i < n && !/[\s/>=]/.test(source[i])) i += 1;
    const name = source.slice(start, i).toLowerCase();
    if (!name) { i += 1; continue; }
    while (i < n && /\s/.test(source[i])) i += 1;
    let value = '';
    if (source[i] === '=') {
      i += 1;
      while (i < n && /\s/.test(source[i])) i += 1;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, i + 1);
        value = source.slice(i + 1, end < 0 ? n : end);
        i = end < 0 ? n : end + 1;
      } else {
        const vstart = i;
        while (i < n && !/[\s>]/.test(source[i])) i += 1;
        value = source.slice(vstart, i);
      }
    }
    if (!(name in attrs)) attrs[name] = decodeAttribute(value);
  }
  return attrs;
}

function makeNode(tag, attrs, parent) {
  return { tag, attrs: attrs || {}, children: [], parent };
}

// Lenient HTML parser: produces a tree of {tag, attrs, children} with string
// children for text. Handles void elements, raw-text elements, comments, and
// the common implied end tags (p, li, td, tr, ...).
export function parseHtml(html) {
  const source = String(html || '');
  const root = makeNode('#root', {}, null);
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const closeTo = (tag) => {
    for (let k = stack.length - 1; k > 0; k -= 1) {
      if (stack[k].tag === tag) { stack.length = k; return true; }
      // Do not let a stray </p> or </li> escape its table cell or list.
      if (['table', 'ul', 'ol', 'td', 'th', 'blockquote', 'article', 'main', 'section', 'div'].includes(stack[k].tag) && tag !== stack[k].tag && ['p', 'li', 'td', 'th', 'tr', 'dt', 'dd'].includes(tag)) return false;
    }
    return false;
  };
  let i = 0;
  const n = source.length;
  let text = '';
  const flush = () => { if (text) { top().children.push(text); text = ''; } };
  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) { text += source.slice(i); break; }
    text += source.slice(i, lt);
    i = lt;
    const next = source[i + 1];
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (next === '!' || next === '?') {
      const end = source.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = next === '/';
    let j = i + (closing ? 2 : 1);
    if (!/[A-Za-z]/.test(source[j] || '')) { text += '<'; i += 1; continue; }
    const nameStart = j;
    while (j < n && /[A-Za-z0-9:_-]/.test(source[j])) j += 1;
    const tag = source.slice(nameStart, j).toLowerCase();
    // Find the end of the tag, respecting quoted attribute values.
    let k = j;
    let quote = '';
    while (k < n) {
      const ch = source[k];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      k += 1;
    }
    const attrSource = source.slice(j, k);
    i = k < n ? k + 1 : n;
    flush();
    if (closing) {
      if (tag === 'p' && !stack.some((node) => node.tag === 'p')) { top().children.push(makeNode('br', {}, top())); continue; }
      if (tag === 'br') { top().children.push(makeNode('br', {}, top())); continue; }
      closeTo(tag);
      continue;
    }
    const attrs = parseAttributes(attrSource);
    const closes = AUTO_CLOSE[tag];
    if (closes) {
      for (let s = stack.length - 1; s > 0; s -= 1) {
        const open = stack[s].tag;
        if (closes.includes(open)) { stack.length = s; break; }
        if (['table', 'ul', 'ol', 'dl', 'div', 'section', 'article', 'main', 'blockquote', 'td', 'th'].includes(open)) break;
      }
    } else if (P_CLOSERS.has(tag)) {
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].tag === 'p') { stack.length = s; break; }
        if (BLOCK.has(stack[s].tag)) break;
      }
    }
    const node = makeNode(tag, attrs, top());
    top().children.push(node);
    if (RAW_TEXT.has(tag)) {
      const endTag = '</' + tag;
      let end = i;
      for (;;) {
        end = source.toLowerCase().indexOf(endTag, end);
        if (end < 0 || !/[A-Za-z0-9]/.test(source[end + endTag.length] || '')) break;
        end += endTag.length;
      }
      const stop = end < 0 ? n : end;
      node.children.push(source.slice(i, stop));
      const close = end < 0 ? -1 : source.indexOf('>', end);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (VOID.has(tag)) continue;
    // Real pages nest a few dozen levels; cap depth so hostile input cannot
    // exhaust the stack in the recursive renderer.
    if (stack.length < MAX_DEPTH) stack.push(node);
  }
  flush();
  return root;
}

function* walk(node) {
  const pending = [node];
  while (pending.length) {
    const item = pending.pop();
    yield item;
    for (let c = item.children.length - 1; c >= 0; c -= 1) if (typeof item.children[c] !== 'string') pending.push(item.children[c]);
  }
}

function find(node, predicate) {
  for (const item of walk(node)) if (predicate(item)) return item;
  return null;
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (DROP.has(node.tag)) return '';
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}

function linkTextLength(node) {
  let total = 0;
  for (const item of walk(node)) if (item.tag === 'a') total += textOf(item).replace(/\s+/g, ' ').trim().length;
  return total;
}

function isHidden(node) {
  const a = node.attrs;
  if ('hidden' in a) return true;
  if (String(a['aria-hidden'] || '').toLowerCase() === 'true') return true;
  if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a.style || '')) return true;
  return false;
}

function classAndId(node) {
  return ((node.attrs.class || '') + ' ' + (node.attrs.id || '')).trim();
}

// Remove nodes that are never content, plus Readability's "unlikely
// candidates" (navigation, sidebars, cookie banners, share bars).
function prune(node, inArticle) {
  const keep = [];
  for (const child of node.children) {
    if (typeof child === 'string') { keep.push(child); continue; }
    if (DROP.has(child.tag) || isHidden(child)) continue;
    const role = String(child.attrs.role || '').toLowerCase();
    if (['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'menu', 'menubar'].includes(role)) continue;
    if (BOILERPLATE_TAGS.has(child.tag) && !(inArticle && child.tag === 'header')) continue;
    const label = classAndId(child);
    if (label && !['body', 'main', 'article', 'html', 'a', 'pre', 'code', 'table', 'tbody', 'tr', 'td', 'th'].includes(child.tag) && UNLIKELY.test(label) && !MAYBE.test(label) && !looksLikeProse(child)) continue;
    prune(child, inArticle || child.tag === 'article' || child.tag === 'main');
    keep.push(child);
  }
  node.children = keep;
}

// A class name like "page__header" can still wrap the page title and intro;
// keep such blocks when they hold the h1 or real, mostly unlinked prose.
function looksLikeProse(node) {
  if (find(node, (n) => n.tag === 'h1')) return true;
  const length = textOf(node).replace(/\s+/g, ' ').trim().length;
  return length >= 300 && linkTextLength(node) / length < 0.35;
}

// Readability's conditional cleaning: inside the chosen content, drop blocks
// that are mostly links (language pickers, file listings, navboxes, tag
// clouds, "on this page" menus) unless they carry code.
function cleanConditionally(node) {
  const keep = [];
  for (const child of node.children) {
    if (typeof child === 'string') { keep.push(child); continue; }
    if (['ul', 'ol', 'div', 'section', 'table', 'dl', 'p', 'span'].includes(child.tag) && !find(child, (n) => n.tag === 'pre' || /^h[1-3]$/.test(n.tag) && child.tag !== 'ul' && child.tag !== 'ol')) {
      const text = textOf(child).replace(/\s+/g, ' ').trim();
      const length = text.length || 1;
      let links = 0;
      for (const item of walk(child)) if (item.tag === 'a') links += 1;
      const density = linkTextLength(child) / length;
      const commas = (text.match(/[,，、]/g) || []).length;
      const negative = classWeight(child) < 0;
      if (links >= 10 && density > 0.5 && commas < 10 || negative && links >= 3 && density > 0.3) continue;
    }
    cleanConditionally(child);
    keep.push(child);
  }
  node.children = keep;
}

function classWeight(node) {
  let weight = 0;
  const label = classAndId(node);
  if (!label) return 0;
  if (NEGATIVE.test(label)) weight -= 25;
  if (POSITIVE.test(label)) weight += 25;
  return weight;
}

// Readability's scoring: every paragraph-like block awards points to its
// parent and (half) grandparent based on text length and comma count; the
// best-scoring container, discounted by link density, is the article.
function scoreCandidates(body) {
  const scores = new Map();
  const init = (node) => {
    if (!scores.has(node)) {
      let base = 0;
      if (['div', 'article', 'main', 'section'].includes(node.tag)) base = 5;
      else if (['pre', 'td', 'blockquote'].includes(node.tag)) base = 3;
      else if (['ol', 'ul', 'dl', 'dd', 'dt', 'li', 'form'].includes(node.tag)) base = -3;
      else if (/^h[1-6]$/.test(node.tag) || node.tag === 'th') base = -5;
      if (node.tag === 'article' || node.tag === 'main' || String(node.attrs.role || '') === 'main') base += 20;
      scores.set(node, base + classWeight(node));
    }
  };
  for (const node of walk(body)) {
    if (!['p', 'pre', 'td', 'li', 'blockquote', 'dd'].includes(node.tag) && !(node.tag === 'div' && !node.children.some((c) => typeof c !== 'string' && BLOCK.has(c.tag)))) continue;
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    if (text.length < 25) continue;
    let ancestor = node.parent;
    let level = 0;
    const points = 1 + (text.match(/[,，、]/g) || []).length + Math.min(3, Math.floor(text.length / 100));
    while (ancestor && ancestor.tag !== '#root' && level < 3) {
      init(ancestor);
      const divider = level === 0 ? 1 : level === 1 ? 2 : level * 3;
      scores.set(ancestor, scores.get(ancestor) + points / divider);
      ancestor = ancestor.parent;
      level += 1;
    }
  }
  let best = null;
  let bestScore = -Infinity;
  for (const [node, score] of scores) {
    const length = textOf(node).replace(/\s+/g, ' ').trim().length || 1;
    const adjusted = score * (1 - Math.min(1, linkTextLength(node) / length));
    if (adjusted > bestScore) { best = node; bestScore = adjusted; }
  }
  return best;
}

function chooseContent(root) {
  const body = find(root, (n) => n.tag === 'body') || root;
  const textLength = (n) => textOf(n).replace(/\s+/g, ' ').trim().length;
  const bodyLength = textLength(body) || 1;
  // Explicit landmarks win when they hold a meaningful share of the text.
  const landmarks = [...walk(body)].filter((n) => n.tag === 'main' || String(n.attrs.role || '').toLowerCase() === 'main' || n.tag === 'article');
  if (landmarks.length) {
    const mains = landmarks.filter((n) => n.tag === 'main' || String(n.attrs.role || '').toLowerCase() === 'main');
    const pool = mains.length ? mains : landmarks;
    const articles = landmarks.filter((n) => n.tag === 'article');
    // Several sibling articles (a blog index) -> use their common container.
    if (!mains.length && articles.length > 1) {
      const parent = articles[0].parent;
      if (parent && articles.every((a) => a.parent === parent)) return parent;
    }
    let largest = pool.reduce((a, b) => (textLength(b) > textLength(a) ? b : a));
    // A <main> that wraps one dominant <article> (a repository page around its
    // README, a docs shell around the page) -> the article.
    if (largest.tag !== 'article') {
      const inner = [...walk(largest)].filter((n) => n !== largest && n.tag === 'article');
      if (inner.length === 1 && textLength(inner[0]) >= textLength(largest) * 0.4) largest = inner[0];
    }
    if (textLength(largest) >= Math.min(200, bodyLength * 0.25)) return largest;
  }
  const scored = scoreCandidates(body);
  if (scored && textLength(scored) >= Math.min(250, bodyLength * 0.2)) {
    // Readability also pulls in siblings that look like continuation content.
    return scored;
  }
  return body;
}

function absolutize(href, base) {
  const value = String(href || '').trim();
  if (!value) return '';
  if (/^(?:javascript|vbscript|data):/i.test(value)) return '';
  try { return base ? new URL(value, base).toString() : value; } catch { return value; }
}

function escapeInline(text) {
  return text.replace(/([\\`*_[\]])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.)(\s)/, '$1\\$2$3');
}

function codeLanguage(node) {
  for (const item of walk(node)) {
    const explicit = item.attrs['data-lang'] || item.attrs['data-language'];
    if (explicit && /^[A-Za-z0-9_+#.-]{1,30}$/.test(explicit)) return String(explicit).toLowerCase();
    const match = String(item.attrs.class || '').match(/(?:^|\s)(?:language|lang|highlight-source|highlight)-([A-Za-z0-9_+#.-]{1,30})/);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function fence(code) {
  let ticks = '```';
  while (code.includes(ticks)) ticks += '`';
  return ticks;
}

class Renderer {
  constructor(base) { this.base = base; }

  inline(node, ctx = {}) {
    if (typeof node === 'string') {
      const decoded = decodeEntities(node);
      return ctx.pre ? decoded : escapeInline(decoded.replace(/\s+/g, ' '));
    }
    const tag = node.tag;
    if (DROP.has(tag)) return '';
    const inner = () => node.children.map((child) => this.inline(child, ctx)).join('');
    switch (tag) {
      case 'br': return ctx.table ? ' ' : '  \n';
      case 'wbr': return '';
      case 'img': {
        const alt = String(node.attrs.alt || '').replace(/\s+/g, ' ').trim();
        const src = absolutize(node.attrs.src || node.attrs['data-src'], this.base);
        return alt && src && !ctx.link ? '![' + escapeInline(alt) + '](' + src + ')' : alt;
      }
      case 'a': {
        const label = node.children.map((child) => this.inline(child, { ...ctx, link: true })).join('').replace(/\s+/g, ' ').trim();
        const raw = String(node.attrs.href || '');
        const href = raw.startsWith('#') ? '' : absolutize(raw, this.base);
        if (!label) return '';
        // Permalink anchors next to headings ("¶", "#", "§", link icons).
        if ((raw.startsWith('#') || /(?:^|\s)(?:headerlink|anchor|anchorjs-link|heading-anchor|hash-link|permalink)(?:\s|$)/.test(node.attrs.class || '')) && /^(?:[¶#§🔗]|\\#|)$/u.test(label)) return '';
        // Very long URLs (share links, tracking payloads) cost more than they help.
        if (!href || ctx.link || href.length > 400) return label;
        return '[' + label + '](' + href.replace(/[()\s]/g, (c) => encodeURIComponent(c)) + ')';
      }
      case 'strong': case 'b': { const t = inner(); return t.trim() ? wrapMarker(t, '**') : t; }
      case 'em': case 'i': case 'cite': case 'dfn': { const t = inner(); return t.trim() ? wrapMarker(t, '_') : t; }
      case 'del': case 's': case 'strike': { const t = inner(); return t.trim() ? wrapMarker(t, '~~') : t; }
      case 'code': case 'kbd': case 'samp': case 'tt': {
        if (ctx.pre) return inner();
        const code = decodeEntities(textOf(node)).replace(/\s+/g, ' ');
        if (!code.trim()) return code;
        const ticks = code.includes('`') ? '``' : '`';
        return ticks + (code.startsWith('`') ? ' ' : '') + code + (code.endsWith('`') ? ' ' : '') + ticks;
      }
      case 'sup': { const t = inner().trim(); return t ? '^' + t : ''; }
      case 'sub': { const t = inner().trim(); return t ? '~' + t : ''; }
      case 'q': return '"' + inner() + '"';
      default: return inner();
    }
  }

  // Render a list of children, grouping inline runs into paragraphs.
  blocks(children, ctx = {}) {
    const out = [];
    let run = [];
    const flushRun = () => {
      if (!run.length) return;
      const text = run.map((child) => this.inline(child, ctx)).join('').replace(/[ \t]+\n/g, '  \n').replace(/^[ \t]+|[ \t]+$/g, '').replace(/ {2,}/g, ' ');
      if (text.replace(/\s+/g, '')) out.push(text.trim());
      run = [];
    };
    for (const child of children) {
      if (typeof child !== 'string' && BLOCK.has(child.tag)) {
        flushRun();
        const rendered = this.block(child, ctx);
        if (rendered && rendered.trim()) out.push(rendered);
      } else run.push(child);
    }
    flushRun();
    return out.join('\n\n');
  }

  block(node, ctx = {}) {
    const tag = node.tag;
    if (DROP.has(tag)) return '';
    if (/^h[1-6]$/.test(tag)) {
      const text = this.inline({ ...node, tag: 'span' }, ctx).replace(/\s+/g, ' ').trim();
      return text ? '#'.repeat(Number(tag[1])) + ' ' + text.replace(/\s*#+\s*$/, '') : '';
    }
    switch (tag) {
      case 'p': return this.blocks(node.children, ctx);
      case 'hr': return '---';
      case 'pre': {
        const code = decodeEntities(preText(node)).replace(/^\n/, '').replace(/\s+$/, '');
        if (!code) return '';
        const ticks = fence(code);
        return ticks + codeLanguage(node) + '\n' + code + '\n' + ticks;
      }
      case 'blockquote': {
        const inner = this.blocks(node.children, ctx);
        return inner ? inner.split('\n').map((line) => (line ? '> ' + line : '>')).join('\n') : '';
      }
      case 'ul': case 'ol': return this.list(node, ctx);
      case 'li': return this.list({ tag: 'ul', attrs: {}, children: [node] }, ctx);
      case 'dl': {
        const parts = [];
        for (const child of node.children) {
          if (typeof child === 'string') continue;
          if (child.tag === 'dt') { const t = this.inline(child, ctx).replace(/\s+/g, ' ').trim(); if (t) parts.push('**' + t + '**'); }
          else if (child.tag === 'dd') { const t = this.blocks(child.children, ctx); if (t) parts.push(t.split('\n').map((l) => (l ? ': ' + l : l)).join('\n').replace(/\n: /g, '\n  ')); }
          else { const t = this.block(child, ctx); if (t) parts.push(t); }
        }
        return parts.join('\n\n');
      }
      case 'table': return this.table(node, ctx);
      case 'details': case 'figure': case 'summary': case 'figcaption': case 'caption':
      default: return this.blocks(node.children, ctx);
    }
  }

  list(node, ctx) {
    const ordered = node.tag === 'ol';
    let index = Number(node.attrs.start) || 1;
    const lines = [];
    for (const child of node.children) {
      if (typeof child === 'string') { if (child.trim()) lines.push('- ' + this.inline(child, ctx).trim()); continue; }
      if (child.tag !== 'li') { const nested = this.block(child, ctx); if (nested) lines.push(nested); continue; }
      const marker = ordered ? index + '. ' : '- ';
      index += 1;
      const body = this.blocks(child.children, ctx).replace(/\n{3,}/g, '\n\n');
      if (!body.trim()) continue;
      const indent = ' '.repeat(marker.length);
      const compact = body.replace(/\n\n(?=\s*(?:[-*]|\d+\.) )/g, '\n');
      lines.push(marker + compact.split('\n').map((line, n) => (n === 0 || !line ? line : indent + line)).join('\n'));
    }
    return lines.join('\n');
  }

  table(node, ctx) {
    const rows = [];
    for (const item of walk(node)) {
      if (item.tag !== 'tr') continue;
      // Skip rows of nested tables; they are flattened into their cell.
      let owner = item.parent;
      while (owner && owner.tag !== 'table') owner = owner.parent;
      if (owner !== node) continue;
      const cells = item.children.filter((c) => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'));
      if (!cells.length) continue;
      const row = [];
      for (const cell of cells) {
        const text = this.blocks(cell.children, { ...ctx, table: true }).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();
        row.push(text);
        const span = Math.min(20, Number(cell.attrs.colspan) || 1);
        for (let s = 1; s < span; s += 1) row.push('');
      }
      rows.push({ cells: row, header: cells.every((c) => c.tag === 'th') || item.parent && item.parent.tag === 'thead' });
    }
    if (!rows.length) return '';
    // A single-column or layout table reads better as paragraphs.
    const width = Math.max(...rows.map((r) => r.cells.length));
    if (width === 1) return rows.map((r) => r.cells[0]).filter(Boolean).join('\n\n');
    const caption = node.children.find((c) => typeof c !== 'string' && c.tag === 'caption');
    const pad = (cells) => [...cells, ...Array(width - cells.length).fill('')];
    const headerIndex = rows.findIndex((r) => r.header);
    const header = headerIndex === 0 ? rows.shift() : { cells: Array(width).fill('') };
    const lines = ['| ' + pad(header.cells).join(' | ') + ' |', '|' + ' --- |'.repeat(width)];
    for (const row of rows) lines.push('| ' + pad(row.cells).join(' | ') + ' |');
    const captionText = caption ? this.inline(caption, ctx).replace(/\s+/g, ' ').trim() : '';
    return (captionText ? '**' + captionText + '**\n\n' : '') + lines.join('\n');
  }
}

function wrapMarker(text, marker) {
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  return lead + marker + text.trim() + marker + trail;
}

function preText(node) {
  if (typeof node === 'string') return node;
  if (node.tag === 'br') return '\n';
  // Line-numbered code viewers put each line in its own block element.
  let out = '';
  for (const child of node.children) {
    if (typeof child !== 'string' && /^(?:div|p|li|tr)$/.test(child.tag)) {
      const line = preText(child);
      out += line.endsWith('\n') ? line : line + '\n';
    } else if (typeof child !== 'string' && (String(child.attrs.class || '').match(/(?:^|\s)(?:linenos?|line-numbers?|gutter|lineno)(?:\s|$)/) || 'aria-hidden' in child.attrs && /^\s*\d+\s*$/.test(textOf(child)))) {
      continue;
    } else out += preText(child);
  }
  return out;
}

function snapshot(node) {
  const saved = new Map();
  for (const item of walk(node)) saved.set(item, item.children.slice());
  return saved;
}

function restore(node, saved) {
  for (const [item, children] of saved) item.children = children;
}

function metaContent(root, names) {
  for (const node of walk(root)) {
    if (node.tag !== 'meta') continue;
    const key = String(node.attrs.property || node.attrs.name || '').toLowerCase();
    if (names.includes(key) && node.attrs.content) return node.attrs.content.replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Convert an HTML document to Markdown.
// options.url: base URL for resolving relative links and images.
// options.extract (default true): keep only the main content.
// Returns { title, description, markdown, extracted }.
export function htmlToMarkdown(html, options = {}) {
  const root = parseHtml(html);
  const titleNode = find(root, (n) => n.tag === 'title');
  const baseNode = find(root, (n) => n.tag === 'base' && n.attrs.href);
  let base = options.url || '';
  if (baseNode) { try { base = new URL(baseNode.attrs.href, base || undefined).toString(); } catch { /* keep page URL */ } }
  const title = decodeEntities(metaContent(root, ['og:title', 'twitter:title']) || (titleNode ? textOf({ ...titleNode, tag: 'span' }) : '')).replace(/\s+/g, ' ').trim();
  const description = decodeEntities(metaContent(root, ['description', 'og:description'])).trim();
  const extract = options.extract !== false;
  let content = find(root, (n) => n.tag === 'body') || root;
  if (extract) {
    prune(root, false);
    content = chooseContent(root);
    const before = textOf(content).replace(/\s+/g, ' ').length;
    const saved = snapshot(content);
    cleanConditionally(content);
    // Never let cleaning gut the page (a link index is legitimately all links).
    if (textOf(content).replace(/\s+/g, ' ').length < before * 0.3) restore(content, saved);
  } else {
    content.children = content.children.filter((c) => typeof c === 'string' || !DROP.has(c.tag));
  }
  const renderer = new Renderer(base);
  let markdown = BLOCK.has(content.tag) || content.tag === '#root' ? renderer.blocks(content.children) : renderer.block(content);
  markdown = markdown.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  // Extraction can be too aggressive on unusual layouts; fall back to the
  // whole body when it kept almost nothing.
  if (extract && markdown.length < 120) {
    const full = htmlToMarkdown(html, { ...options, extract: false });
    if (full.markdown.length > markdown.length * 2) return { ...full, extracted: false };
  }
  const startsWithTitle = title && markdown.slice(0, title.length + 4).replace(/^#+\s*/, '').startsWith(title.slice(0, 40));
  return { title, description, markdown, extracted: extract && content.tag !== 'body' && content.tag !== '#root', titleInBody: Boolean(startsWithTitle) };
}
