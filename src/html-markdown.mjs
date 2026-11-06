// HTML -> Markdown for fetch_url and /web: main-content extraction and Markdown
// rendering by Defuddle (github.com/kepano/defuddle, MIT; the Obsidian Web
// Clipper engine and a Readability successor) over a linkedom DOM, with
// Defuddle's turndown-based renderer. It standardizes code blocks (keeping the
// language), footnotes, math and tables, and has site extractors for GitHub,
// Hacker News, Reddit and others.
//
// Safety: Defuddle's async extractors can call third-party APIs on their own;
// they are disabled (useAsync: false, and a fetch that refuses), so the only
// network request is the validated public fetch that produced the HTML. Script
// and data URLs are removed before conversion.
//
// Conversion runs in a worker thread: a 1 MB page takes a second or two of CPU,
// which would otherwise freeze the terminal, and its cost grows faster than
// linearly on pathological markup. Past the deadline (15 s, or
// OASIS_HTML_CONVERT_TIMEOUT_MS) the worker is stopped and the page comes back
// as plain text.

import { Worker } from 'node:worker_threads';
import { decodeHTML } from 'entities';

// linkedom and Defuddle cost ~200 ms to import, so they load on the first
// conversion rather than with every OASIS start.
let parseHTML;
let Defuddle;
let loading;
function loadDom() {
  if (!loading) {
    loading = Promise.all([import('linkedom'), import('defuddle/node')]).then(([dom, defuddle]) => {
      parseHTML = dom.parseHTML;
      Defuddle = defuddle.Defuddle;
    });
  }
  return loading;
}

const UNSAFE_URL = /^\s*(?:javascript|vbscript|data|file):/i;
const URL_ATTRIBUTES = ['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'xlink:href'];
const refuseFetch = async () => { throw new Error('network access is disabled during HTML conversion'); };

// Character references decoded by `entities`; no-break and fixed-width spaces
// become plain spaces and soft hyphens vanish.
export function decodeEntities(text) {
  const value = String(text || '');
  return (value.includes('&') ? decodeHTML(value) : value).replace(/[\u00a0\u2002\u2003\u2009]/g, ' ').replace(/\u00ad/g, '');
}

function parse(html) {
  let source = String(html || '');
  // linkedom builds a document only from a full page; wrap fragments.
  if (!/<body[\s>]/i.test(source)) {
    const head = (source.match(/<head[\s>][\s\S]*?<\/head>/i) || [''])[0];
    const rest = source.replace(/<head[\s>][\s\S]*?<\/head>/i, '').replace(/<\/?html[^>]*>|<!doctype[^>]*>/gi, '');
    source = '<!DOCTYPE html><html>' + (head || '<head></head>') + '<body>' + rest + '</body></html>';
  }
  const { document } = parseHTML(source);
  for (const attribute of URL_ATTRIBUTES) {
    for (const element of document.querySelectorAll('[' + attribute.replace(':', '\\:') + ']')) {
      if (UNSAFE_URL.test(element.getAttribute(attribute) || '')) element.removeAttribute(attribute);
    }
  }
  // linkedom computes no styles, so hidden content is removed by its markup.
  for (const element of document.querySelectorAll('[hidden], [aria-hidden="true"], template, noscript')) element.remove();
  for (const element of document.querySelectorAll('[style]')) {
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(element.getAttribute('style') || '')) element.remove();
  }
  // A header-classed block inside the main content that holds the title and an
  // intro paragraph is content; keep Defuddle's "header" class rules off it.
  for (const element of document.querySelectorAll('main [class*="header"], article [class*="header"], main [id*="header"], article [id*="header"]')) {
    if (element.querySelector('h1') && element.querySelector('p')) { element.removeAttribute('class'); element.removeAttribute('id'); }
  }
  limitDepth(document);
  return document;
}

// Defuddle's scoring revisits ancestors, so its cost grows steeply with nesting
// depth (about 1 s at 500 levels, 3.4 s at 1000). Real pages stay well under 64
// levels; anything deeper is collapsed to its text so hostile markup stays fast.
const MAX_DEPTH = 64;
function limitDepth(document) {
  const root = document.documentElement;
  if (!root) return;
  const stack = [[root, 0]];
  while (stack.length) {
    const [element, depth] = stack.pop();
    if (depth >= MAX_DEPTH) {
      if (element.firstElementChild) element.textContent = element.textContent;
      continue;
    }
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) stack.push([child, depth + 1]);
  }
}

async function convert(html, url, extract) {
  // removeContentPatterns is off: its "blog metadata list" rule deletes short
  // real lists (steps, options, platforms) from documentation pages.
  const options = { markdown: true, useAsync: false, fetch: refuseFetch, includeReplies: 'extractors', removeContentPatterns: false };
  if (!extract) Object.assign(options, { contentSelector: 'body', removeLowScoring: false, removeExactSelectors: false, removePartialSelectors: false, removeContentPatterns: false });
  await loadDom();
  const document = parse(html);
  let result;
  try {
    result = await Defuddle(document, url, options);
  } catch {
    // Defuddle could not process the page: keep its text rather than fail.
    result = { title: document.title || '', description: '', content: (document.body && document.body.textContent) || '' };
  }
  const markdown = String(result.content || '')
    .replace(/\[([^\]]*)\]\(\s*(?:javascript|vbscript|data|file):[^)]*\)/gi, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { result, markdown };
}

export async function convertHtmlInProcess(html, options = {}) {
  let url = options.url || undefined;
  if (url) { try { url = new URL(url).toString(); } catch { url = undefined; } }
  const extract = options.extract !== false;
  let { result, markdown } = await convert(html, url, extract);
  let extracted = extract;
  // Extraction can be too aggressive on unusual layouts; fall back to the whole
  // body when it kept almost nothing.
  if (extract && markdown.length < 120) {
    const full = await convert(html, url, false);
    if (full.markdown.length > markdown.length * 2) { ({ result, markdown } = full); extracted = false; }
  }
  const title = decodeEntities(result.title || '').replace(/\s+/g, ' ').trim();
  const description = decodeEntities(result.description || '').replace(/\s+/g, ' ').trim();
  const opening = markdown.slice(0, title.length + 4).replace(/^#+\s*/, '');
  return { title, description, markdown, extracted, titleInBody: Boolean(title) && opening.startsWith(title.slice(0, 40)) };
}

const BLOCK = /^(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)$/i;

// Linear plain-text rendering used when full conversion runs out of time.
export async function htmlToPlainText(html) {
  await loadDom();
  const document = parse(html);
  for (const element of document.querySelectorAll('script, style, noscript, template, svg, [hidden]')) element.remove();
  const parts = [];
  const stack = document.body ? [document.body] : [];
  while (stack.length) {
    const node = stack.pop();
    if (node === '\n') { parts.push('\n'); continue; }
    if (node.nodeType === 3) { parts.push(node.textContent); continue; }
    if (node.nodeType !== 1) continue;
    const block = BLOCK.test(node.localName || '');
    if (block) stack.push('\n');
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
    if (block) parts.push('\n');
  }
  return decodeEntities(parts.join('')).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

let worker = null;
let nextId = 1;
const pending = new Map();

function startWorker() {
  const instance = new Worker(new URL('./html-markdown-worker.mjs', import.meta.url));
  instance.unref();
  instance.on('message', ({ id, result, error }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    clearTimeout(job.timer);
    if (!pending.size) instance.unref();
    if (error) job.reject(new Error(error)); else job.resolve(result);
  });
  const fail = (error) => {
    if (worker === instance) worker = null;
    for (const [id, job] of pending) { if (job.worker === instance) { pending.delete(id); clearTimeout(job.timer); job.reject(error instanceof Error ? error : new Error('HTML converter stopped')); } }
  };
  instance.on('error', fail);
  instance.on('exit', () => fail(new Error('HTML converter stopped')));
  return instance;
}

function timeoutFor(options) {
  const value = Number(options.timeoutMs ?? process.env.OASIS_HTML_CONVERT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 15_000;
}

async function fallback(html, reason) {
  await loadDom();
  const document = parse(html);
  return { title: decodeEntities(document.title || '').replace(/\s+/g, ' ').trim(), description: '', markdown: await htmlToPlainText(html), extracted: false, titleInBody: false, degraded: reason };
}

export async function htmlToMarkdown(html, options = {}) {
  const text = String(html || '');
  if (options.inline) return convertHtmlInProcess(text, options);
  const instance = worker || (worker = startWorker());
  const id = nextId++;
  const timeout = timeoutFor(options);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        if (worker === instance) worker = null;
        instance.terminate().catch(() => {});
        reject(Object.assign(new Error('timeout'), { timeout: true }));
      }, timeout);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, worker: instance });
      instance.ref();
      instance.postMessage({ id, html: text, options: { url: options.url, extract: options.extract } });
    });
  } catch (error) {
    return fallback(text, error && error.timeout ? 'converter timed out after ' + timeout + ' ms; returned plain text' : 'converter failed; returned plain text');
  }
}
