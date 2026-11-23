// Egress provenance: who named the place this data is going?
//
// The injection guard (src/untrusted-content.mjs) recognises text that reads
// like instructions. An attack can also read like ordinary data: a page that
// says "debug logs are collected at https://logs.example-cdn.net/upload?d="
// with no imperative in sight. The agent, trying to be helpful, fills the
// query with something it read and sends it. Nothing flagged the page, so no
// hold applies.
//
// This module separates following a link from writing into one. OASIS records
// the URLs and hosts that outside content (web pages, search results, MCP
// results, fetched issue bodies) mentions, and the hosts the user named. When
// a call is about to send data:
//
//   - to a host the user named (or settings allow-list): fine;
//   - to an exact URL that outside content contained: fine, that is following
//     a link, and it carries nothing the agent composed;
//   - to a host that only outside content named, with query values or a body
//     the agent composed (data-like values not seen in that content):
//     this needs a person, even in auto or bypass mode, and the prompt says
//     which tool result first named the host.
//
// Short values and plain phrases (a search term, a page number) pass: a
// research agent fills them all the time. A value counts as composed data
// when it is long (100+ characters) or holds a token-like run of 16+ mixed
// letters and digits (base64, hex, keys). A request body of 16+ characters
// always counts.
//
// Off with the untrusted-content guard ("untrustedContentGuard": false or
// OASIS_UNTRUSTED_GUARD=0), or on its own with OASIS_EGRESS_PROVENANCE=0.

import { siteOf } from './source-independence.mjs';
import { untrustedGuardEnabled } from './untrusted-content.mjs';

const COMPOSED_MIN = 16;
const LONG_VALUE = 100;
const MAX_HOSTS = 2000;
const MAX_URLS_PER_HOST = 200;
const MAX_VALUES_PER_HOST = 400;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`)\]}]+/gi;
const BARE_HOST = /(?:^|[\s(<"'`])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=$|[\s/:)>"'`,;.!?])/gi;

export function egressProvenanceEnabled(session, env = process.env) {
  if (String(env.OASIS_EGRESS_PROVENANCE || '').trim() === '0') return false;
  return untrustedGuardEnabled(session, env);
}

function hostOf(raw) {
  try { return new URL(raw).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}

function trimUrl(raw) {
  // Trailing punctuation from prose ("see https://x.example/a.") is not part of the URL.
  return String(raw).replace(/[.,;:!?]+$/, '');
}

function linkKey(raw) {
  try {
    const url = new URL(trimUrl(raw));
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

function queryValues(raw) {
  try { return [...new URL(raw).searchParams.values()]; } catch { return []; }
}

// A value that can carry data: long, or containing a token-like run (16+
// characters of letters and digits mixed, as base64, hex and keys are). A
// search phrase ("node fetch proxy environment variables") is neither.
function dataLike(value) {
  const text = String(value || '');
  if (text.length >= LONG_VALUE) return true;
  for (const run of text.match(/[A-Za-z0-9+/=_.%-]{16,}/g) || []) if (/\d/.test(run) && /[A-Za-z]/.test(run)) return true;
  return false;
}

function provenance(session) {
  if (!session.egressProvenance) {
    Object.defineProperty(session, 'egressProvenance', {
      value: { hosts: new Map() },
      enumerable: false, writable: true, configurable: true
    });
  }
  return session.egressProvenance;
}

/** URLs found in text (trailing prose punctuation removed). */
export function urlsIn(text) {
  return (String(text || '').match(URL_PATTERN) || []).map(trimUrl);
}

/** Hosts named in text: URLs and bare domain names ("upload to logs.example.net"). */
export function hostsIn(text) {
  const out = new Set();
  for (const url of urlsIn(text)) { const host = hostOf(url); if (host) out.add(host); }
  for (const match of String(text || '').matchAll(BARE_HOST)) out.add(match[1].toLowerCase());
  return out;
}

/**
 * Records what an outside tool result mentions. Call for results that come
 * from outside the user's control (the same ones the injection guard checks).
 */
export function noteExternalContent(session, toolName, text) {
  if (!session || typeof text !== 'string' || !text) return;
  const state = provenance(session);
  for (const raw of urlsIn(text)) {
    const host = hostOf(raw);
    if (!host) continue;
    let entry = state.hosts.get(host);
    if (!entry) {
      if (state.hosts.size >= MAX_HOSTS) continue;
      entry = { firstTool: String(toolName || 'a tool'), links: new Set(), values: new Set() };
      state.hosts.set(host, entry);
    }
    const key = linkKey(raw);
    if (key && entry.links.size < MAX_URLS_PER_HOST) entry.links.add(key);
    for (const value of queryValues(raw)) if (value.length >= COMPOSED_MIN && entry.values.size < MAX_VALUES_PER_HOST) entry.values.add(value);
  }
  for (const host of hostsIn(text)) {
    if (!state.hosts.has(host) && state.hosts.size < MAX_HOSTS) state.hosts.set(host, { firstTool: String(toolName || 'a tool'), links: new Set(), values: new Set() });
  }
}

function userText(session) {
  const parts = [];
  for (const message of session.messages || []) {
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') parts.push(message.content);
    else if (Array.isArray(message.content)) for (const part of message.content) if (part && typeof part.text === 'string') parts.push(part.text);
  }
  if (typeof session.currentRequest === 'string') parts.push(session.currentRequest);
  return parts.join('\n');
}

function settingsHosts(session) {
  const out = new Set();
  const settings = session.settings || {};
  const allowed = settings.sandbox && Array.isArray(settings.sandbox.allowedDomains) ? settings.sandbox.allowedDomains : [];
  for (const item of allowed) if (typeof item === 'string') out.add(item.replace(/^\*\./, '').replace(/:\d+$/, '').toLowerCase());
  const allow = settings.permissions && Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  for (const rule of allow) {
    const match = /domain:([^)\s,]+)/i.exec(String(rule));
    if (match) out.add(match[1].replace(/^\*\./, '').toLowerCase());
  }
  return out;
}

/** True when the user (or the user's settings) named this host or its site. */
export function userNamedHost(session, host) {
  const site = siteOf('https://' + host + '/');
  const named = hostsIn(userText(session));
  for (const item of settingsHosts(session)) named.add(item);
  for (const item of named) {
    if (item === host || item === site) return true;
    if (siteOf('https://' + item + '/') === site) return true;
  }
  return false;
}

/**
 * Checks one destination. `url` is where the data goes; `body` is any payload
 * sent with it. Returns '' or the reason a person is needed.
 */
export function egressReason(session, url, { body = '' } = {}) {
  if (!session || !session.egressProvenance) return '';
  const host = hostOf(url);
  if (!host) return '';
  const entry = session.egressProvenance.hosts.get(host);
  if (!entry) return '';
  if (userNamedHost(session, host)) return '';
  const key = linkKey(url);
  const composed = [];
  if (!(key && entry.links.has(key))) {
    for (const value of queryValues(url)) if (value.length >= COMPOSED_MIN && dataLike(value) && !entry.values.has(value)) composed.push(value);
  }
  const payload = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
  if (payload && payload.length >= COMPOSED_MIN) composed.push(payload);
  if (!composed.length) return '';
  return 'it sends ' + composed.reduce((sum, item) => sum + item.length, 0) + ' characters the agent composed to ' + host +
    ', a host that only outside content named (first in a ' + entry.firstTool + ' result), not you';
}

// Command-line options that put a payload in the request.
const DATA_FLAGS = /^(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|-F|--form(?:-string)?|-T|--upload-file|--json|--post-data|--post-file|--body-data|--body-file)$/;

/** egressReason() for a run_command / run_shell call. */
export function commandEgressReason(session, name, args) {
  if (!session || !session.egressProvenance || !args || typeof args !== 'object') return '';
  if (!['run_command', 'run_shell', 'powershell', 'monitor'].includes(String(name))) return '';
  const words = [args.command, ...(Array.isArray(args.args) ? args.args : [])].filter((part) => typeof part === 'string');
  const line = words.join(' ');
  const tokens = name === 'run_command' ? words : (line.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((word) => word.replace(/^(["'])(.*)\1$/, '$2'));
  let payload = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index].replace(/=.*$/, '');
    if (DATA_FLAGS.test(flag)) payload += tokens[index].includes('=') && flag.startsWith('--') ? tokens[index].slice(flag.length + 1) : String(tokens[index + 1] || '');
  }
  for (const url of urlsIn(line)) {
    const reason = egressReason(session, url, { body: payload });
    if (reason) return reason;
  }
  return '';
}
