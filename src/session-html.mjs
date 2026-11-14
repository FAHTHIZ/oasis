// Standalone HTML export of a conversation (/export FILE.html), like Pi's and
// goose's session export. The page is one file with inline CSS and no script:
// a Content-Security-Policy blocks scripts and every remote load, Markdown goes
// through the web app's safe renderer (raw HTML shown as text, http(s)/mailto
// links only), and credentials are redacted before anything is written.

import { renderMarkdown } from '../app/markdown.mjs';
import { redactSecretText } from './secret-shield.mjs';
import { isOasisAuthoredPrompt } from './sessions.mjs';

const MAX_TOOL_TEXT = 20000;
const MAX_IMAGE_URL = 4 * 1024 * 1024;

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clip(text, max) {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(0, max) + '\n… (' + (value.length - max) + ' more characters)' : value;
}

function parts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.filter((part) => part && typeof part === 'object');
  return content ? [{ type: 'text', text: JSON.stringify(content) }] : [];
}

function textOf(content) {
  return parts(content).map((part) => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function imagesOf(content) {
  const urls = [];
  for (const part of parts(content)) {
    const url = part.type === 'image_url' ? (part.image_url && part.image_url.url) : part.type === 'image' && part.source && part.source.type === 'base64' ? 'data:' + part.source.media_type + ';base64,' + part.source.data : '';
    // Only inline images are kept; remote URLs would be blocked by the CSP anyway.
    if (typeof url === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url) && url.length <= MAX_IMAGE_URL) urls.push(url);
  }
  return urls;
}

function isReminder(message) {
  const text = textOf(message.content).trim();
  return message.role === 'user' && isOasisAuthoredPrompt(text);
}

function prettyArguments(raw) {
  const text = String(raw == null ? '' : raw);
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function toolSummary(name, raw) {
  let args = {};
  try { args = JSON.parse(String(raw || '{}')) || {}; } catch { args = {}; }
  const hint = args.path || args.file_path || args.command || args.pattern || args.query || args.url || args.description || '';
  return typeof hint === 'string' && hint ? clip(hint.replace(/\s+/g, ' '), 120) : '';
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f8f5;--card:#fff;--text:#0f1a12;--muted:#55645a;--line:#dfe5df;--accent:#16803c;--user:#e9f3ec;--code:#f0f2ee}
@media (prefers-color-scheme:dark){:root{--bg:#0e1310;--card:#151c17;--text:#e8efe9;--muted:#9baa9f;--line:#253029;--accent:#4ade80;--user:#1b2a20;--code:#1a221c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 64px}
header{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:24px}
h1{font-size:20px;margin:0 0 6px}.meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 16px}
.msg{margin:18px 0}.role{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.user .body{background:var(--user);border-radius:12px;padding:10px 14px;white-space:pre-wrap;overflow-wrap:anywhere}
.assistant .body{overflow-wrap:anywhere}.assistant .body>:first-child{margin-top:0}.assistant .body>:last-child{margin-bottom:0}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
:not(pre)>code{background:var(--code);padding:1px 5px;border-radius:4px}
a{color:var(--accent)}table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:4px 8px}
details.tool{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:8px 0;padding:0 12px}
details.tool summary{cursor:pointer;padding:8px 0;font-size:13.5px;list-style-position:inside}
details.tool summary b{font-weight:600}details.tool summary span{color:var(--muted);font-family:ui-monospace,monospace;font-size:12.5px;margin-left:6px}
details.tool .label{font-size:12px;color:var(--muted);margin:6px 0 2px}
.status{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:0 6px;margin-left:6px;color:var(--muted)}.status.error{color:#c2410c;border-color:#c2410c}
img.attached{max-width:100%;border-radius:8px;border:1px solid var(--line);margin-top:8px}
footer{margin-top:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
@media print{details.tool{break-inside:avoid}details.tool:not([open]) summary::after{content:""}}
`;

/**
 * Renders the session as one self-contained HTML document. Tool calls are
 * paired with their results and shown as collapsible steps.
 */
export function conversationHtml(session, { now = new Date(), version = '' } = {}) {
  const messages = Array.isArray(session && session.messages) ? session.messages.slice(1) : [];
  const results = new Map();
  for (const message of messages) if (message && message.role === 'tool' && message.tool_call_id) results.set(message.tool_call_id, message);
  const model = String(session && session.config && session.config.model || 'unknown');
  const root = String(session && session.root || '');
  const safe = (text) => redactSecretText(String(text == null ? '' : text));
  const out = [];
  let turns = 0;
  let steps = 0;
  for (const message of messages) {
    if (!message || isReminder(message)) continue;
    if (message.role === 'user') {
      const text = textOf(message.content);
      const images = imagesOf(message.content);
      if (!text.trim() && !images.length) continue;
      turns += 1;
      out.push('<section class="msg user"><div class="role">You</div><div class="body">' + escapeHtml(safe(text)) + images.map((url) => '<img class="attached" alt="Attached image" src="' + escapeHtml(url) + '">').join('') + '</div></section>');
    } else if (message.role === 'assistant') {
      const text = textOf(message.content);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (text.trim()) out.push('<section class="msg assistant"><div class="role">OASIS</div><div class="body">' + renderMarkdown(safe(text)).replace(/<button class="copy" type="button">Copy<\/button>/g, '') + '</div></section>');
      for (const call of calls) {
        steps += 1;
        const name = String(call && call.function && call.function.name || 'tool');
        const rawArgs = call && call.function && call.function.arguments;
        const result = results.get(call && call.id);
        const resultText = result ? textOf(result.content) : '';
        const failed = /^(error|tool error)\b|"(error|ok)":\s*(?:"|false)/i.test(resultText.slice(0, 200));
        const hint = toolSummary(name, rawArgs);
        out.push('<details class="tool"><summary><b>' + escapeHtml(name) + '</b>' + (hint ? '<span>' + escapeHtml(safe(hint)) + '</span>' : '') + (result ? '' : '<em class="status">no result</em>') + (failed ? '<em class="status error">error</em>' : '') + '</summary>'
          + '<div class="label">Input</div><pre>' + escapeHtml(safe(clip(prettyArguments(rawArgs), MAX_TOOL_TEXT))) + '</pre>'
          + (result ? '<div class="label">Result</div><pre>' + escapeHtml(safe(clip(resultText, MAX_TOOL_TEXT))) + '</pre>' + imagesOf(result.content).map((url) => '<img class="attached" alt="Tool image" src="' + escapeHtml(url) + '">').join('') : '')
          + '</details>');
      }
    }
  }
  const title = 'OASIS conversation' + (root ? ' · ' + root.split(/[\\/]/).filter(Boolean).pop() : '');
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">'
    + '<title>' + escapeHtml(title) + '</title><style>' + STYLE + '</style></head><body><main>'
    + '<header><h1>' + escapeHtml(title) + '</h1><div class="meta"><span>Model: ' + escapeHtml(model) + '</span>' + (root ? '<span>Workspace: ' + escapeHtml(root) + '</span>' : '') + '<span>' + turns + (turns === 1 ? ' message' : ' messages') + ' · ' + steps + (steps === 1 ? ' tool step' : ' tool steps') + '</span><span>Exported ' + escapeHtml(now.toISOString().replace('T', ' ').slice(0, 16)) + ' UTC</span></div></header>'
    + out.join('\n')
    + '<footer>Exported from OASIS' + (version ? ' ' + escapeHtml(version) : '') + '. Credentials that OASIS recognises were redacted.</footer>'
    + '</main></body></html>\n';
}
