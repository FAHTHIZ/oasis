// The built-in browser tool (`--chrome` / `/chrome`, also `/browser`).
//
// The agent opens pages, reads them, clicks, types, fills forms, takes screenshots,
// downloads files and reads console and network activity through the Chrome
// DevTools Protocol. Two engines sit behind it (browser-engine.mjs): Obscura, a
// light headless engine that is the default, and Chrome/Chromium/Edge for visible
// windows, attaching to your own signed-in browser (OASIS_CHROME_PORT) and as the
// automatic fallback for pages Obscura cannot load or render.
//
// Each session (and each subagent) gets its own browser with a private profile,
// so cookies and storage never cross between agents. Visiting a new site, any
// page access to local or private-network addresses, file: URLs and running page
// JavaScript ask first unless the call is auto-approved.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Browser } from './cdp.mjs';
import { installObscura, obscuraAsset, resolveEngine } from './browser-engine.mjs';
import { RECORDED_ACTIONS, addFrame, capturePage, newRecording, recordingEnabled, saveRecording, stepCaption } from './browser-recording.mjs';
import { isNonPublicIpAddress } from './network-safety.mjs';
import { agentDisplayEnv, wantsVirtualDisplay } from './computer-use.mjs';

export const BROWSER_ACTIONS = ['navigate', 'snapshot', 'read', 'click', 'type', 'select', 'hover', 'press', 'scroll', 'wait', 'screenshot', 'evaluate', 'back', 'forward', 'reload', 'download', 'recording', 'console', 'network', 'tabs', 'new_tab', 'switch_tab', 'close_tab', 'engine', 'close'];

export const BROWSER_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'browser',
    description: 'Drive a real web browser. Actions: navigate {url}; snapshot (page text plus numbered interactive elements; use their ref in later calls); read (the page as clean Markdown, for articles, docs and search results); click {ref|selector|text}; type {ref|selector, text, clear?, submit?}; select {ref|selector, value} (choose a dropdown option by value or label); hover {ref|selector|text}; press {key, e.g. Enter, Tab, Escape, ArrowDown}; scroll {direction: up|down, amount?}; wait {text?|ms?}; screenshot {full_page?, ref?|selector?} (you see the image); evaluate {expression} (page JavaScript); back; forward; reload; download {url|ref, filename?} (save a file into .oasis/downloads with the page\'s cookies); recording (save a replayable recording of the steps so far to .oasis/recordings and return its path); console (recent console messages and errors); network (recent requests, failures first); tabs; new_tab {url?}; switch_tab {index}; close_tab; engine {engine?: obscura|chrome} (show or switch the browser engine; pages Obscura cannot load switch to Chrome by themselves); close. Take a snapshot after navigating or after the page changes, then act on refs. Use it to check web UIs you build, reproduce bugs, research and read pages that need JavaScript, fill in forms and download files.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: BROWSER_ACTIONS },
        url: { type: 'string' },
        ref: { type: 'integer', description: 'Element number from the latest snapshot' },
        selector: { type: 'string', description: 'CSS selector, as an alternative to ref' },
        text: { type: 'string', description: 'Text to type, link/button text to click, or text to wait for' },
        value: { type: 'string', description: 'Option value or label for select' },
        key: { type: 'string' },
        clear: { type: 'boolean' },
        submit: { type: 'boolean' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'integer' },
        ms: { type: 'integer' },
        full_page: { type: 'boolean' },
        expression: { type: 'string' },
        index: { type: 'integer' },
        filename: { type: 'string' },
        engine: { type: 'string', enum: ['obscura', 'chrome'] }
      },
      required: ['action']
    }
  }
};

const MAX_BROWSER_NAVIGATION_URL = 32 * 1024;

// Opaque URL schemes do not provide a stable web origin. Approval must be bound
// to the exact target, not the shared string "null" or a synthetic file origin.
export function browserNavigationPolicy(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) throw new Error('navigate needs a url.');
  if (url.length > MAX_BROWSER_NAVIGATION_URL) throw new Error('The browser URL is too long (maximum 32 KiB).');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = (/^(localhost|127\.|\[::1\])/.test(url) ? 'http://' : 'https://') + url;
  const parsed = new URL(url);
  if (!['http:', 'https:', 'file:', 'about:', 'data:'].includes(parsed.protocol)) {
    throw new Error('Only http, https, file, about and data URLs can be opened.');
  }
  if (parsed.username || parsed.password) throw new Error('Browser URLs must not embed usernames or passwords.');
  const localHttp = ['http:', 'https:'].includes(parsed.protocol) &&
    /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(parsed.hostname);
  const localBlank = parsed.protocol === 'about:' && parsed.href === 'about:blank';
  const opaqueTarget = ['file:', 'data:'].includes(parsed.protocol) ||
    (parsed.protocol === 'about:' && !localBlank);
  return {
    url: parsed.href,
    protocol: parsed.protocol,
    local: localHttp || localBlank,
    localHttp,
    localBlank,
    approvalKey: opaqueTarget ? 'opaque-target:' + parsed.href : parsed.origin,
    approvalTarget: opaqueTarget ? parsed.href.slice(0, 1200) : parsed.origin
  };
}

export function browserNavigationNeedsApproval(rawUrl, approvedNavigations, { strictLocal = false } = {}) {
  const policy = rawUrl && typeof rawUrl === 'object' && typeof rawUrl.approvalKey === 'string'
    ? rawUrl
    : browserNavigationPolicy(rawUrl);
  const localBypass = policy.localBlank || (policy.localHttp && !strictLocal);
  return !localBypass && !approvedNavigations.has(policy.approvalKey);
}

export async function isPrivateBrowserRequest(rawUrl, lookupImpl = lookup) {
  let parsed;
  try { parsed = new URL(String(rawUrl)); } catch { return true; }
  // Page-initiated file/about requests are local-resource access too. Gate them
  // through the same approval path instead of letting subframes bypass the
  // HTTP(S)-only host checks below. Data URLs remain non-network content.
  if (parsed.protocol === 'file:' || parsed.protocol === 'about:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.home.arpa') ||
      host === 'metadata' || host === 'metadata.google.internal' || (!host.includes('.') && isIP(host) === 0)) return true;
  if (isIP(host)) return isNonPublicIpAddress(host);

  // Resolve every address family before allowing page-initiated network access.
  // A mixed public/private answer is treated as private. This is DNS-aware
  // approval gating; with Obscura the engine itself also refuses private
  // addresses at connect time unless the user approved one (see launchFor).
  // A page pulls hundreds of subresources from a few hosts; answers are shared for
  // a short while (and lookups already in flight are joined) so a busy page does
  // not queue hundreds of resolver calls. Failures are never cached.
  if (lookupImpl !== lookup) return classifyRecords(await resolveAll(lookupImpl, host));
  const now = Date.now();
  const hit = HOST_VERDICTS.get(host);
  if (hit && hit.expires > now) return hit.verdict;
  const verdict = (hit && hit.pending) || resolveAll(lookupImpl, host).then(classifyRecords);
  HOST_VERDICTS.set(host, { pending: verdict, expires: Infinity });
  try {
    const result = await verdict;
    HOST_VERDICTS.set(host, { verdict: result, expires: Date.now() + HOST_VERDICT_TTL_MS });
    if (HOST_VERDICTS.size > 1024) HOST_VERDICTS.delete(HOST_VERDICTS.keys().next().value);
    return result;
  } catch (error) {
    HOST_VERDICTS.delete(host);
    throw error;
  }
}

const HOST_VERDICTS = new Map();
const HOST_VERDICT_TTL_MS = 30_000;

async function resolveAll(lookupImpl, host) {
  let records;
  try { records = await lookupImpl(host, { all: true, verbatim: true }); }
  catch { throw new Error('Could not resolve browser request hostname safely.'); }
  if (!Array.isArray(records) || !records.length) throw new Error('Browser request hostname returned no addresses.');
  return records;
}

function classifyRecords(records) {
  return records.some((record) => {
    let address = String(record && record.address || '');
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    return !isIP(address) || isNonPublicIpAddress(address);
  });
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 }, Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' }
};

// Element refs live in a page-side registry under a per-session random name,
// holding weak references. Nothing is written into the page's DOM (the old
// data-oasis-ref attributes showed up in the page's own markup, could break
// framework hydration and could be spoofed by the page), and refs reach into
// open shadow roots.
const DEFAULT_REF_KEY = '__oasisRefs';

export function snapshotJs(refKey = DEFAULT_REF_KEY) {
  return `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const key = ${JSON.stringify(refKey)};
  const registry = new Map();
  const scope = typeof window === 'object' && window ? window : globalThis;
  try { Object.defineProperty(scope, key, { value: registry, configurable: true, enumerable: false, writable: true }); } catch { scope[key] = registry; }
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox], [role=searchbox], [contenteditable=true], [contenteditable=""], [onclick]';
  const found = [];
  const seen = new Set();
  const walk = (root, depth) => {
    for (const el of root.querySelectorAll(sel)) { if (!seen.has(el)) { seen.add(el); found.push(el); } }
    if (depth > 8 || !root.querySelectorAll) return;
    for (const host of root.querySelectorAll('*')) { if (host.shadowRoot) walk(host.shadowRoot, depth + 1); }
  };
  walk(document, 0);
  const labelFor = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) { const text = by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText || n.textContent || '' : ''; }).join(' ').trim(); if (text) return text; }
    if (el.id && el.labels === undefined) { const l = document.querySelector('label[for="' + String(el.id).replace(/"/g, '') + '"]'); if (l) return l.innerText || l.textContent || ''; }
    if (el.labels && el.labels.length) return [...el.labels].map((l) => l.innerText || l.textContent || '').join(' ');
    return '';
  };
  const items = [];
  let n = 0;
  let skipped = 0;
  for (const el of found) {
    if (!visible(el)) continue;
    if (n >= 300) { skipped++; continue; }
    n += 1;
    registry.set(n, typeof WeakRef === 'function' ? new WeakRef(el) : { deref: () => el });
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    const name = (el.getAttribute('aria-label') || (field ? labelFor(el) : '') || (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : el.innerText) || (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : el.tagName !== 'INPUT' || /^(submit|button|reset)$/.test(el.type) ? el.value : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (field ? '' : labelFor(el)) || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const item = { ref: n, tag: el.tagName.toLowerCase(), name };
    const role = el.getAttribute('role'); if (role) item.role = role;
    if (el.type && el.tagName !== 'BUTTON') item.type = el.type;
    if (el.href) item.href = String(el.href).slice(0, 200);
    if (field && el.getAttribute('placeholder') && item.name !== el.getAttribute('placeholder')) item.placeholder = String(el.getAttribute('placeholder')).slice(0, 80);
    if ('value' in el && el.value && el.tagName !== 'BUTTON' && !/^(password)$/i.test(el.type || '')) item.value = String(el.value).slice(0, 80);
    if (el.tagName === 'SELECT' && el.options) item.options = [...el.options].slice(0, 25).map((o) => (o.selected ? '* ' : '') + String(o.label || o.text || o.value).trim().slice(0, 50));
    if (el.checked) item.checked = true;
    if (el.disabled) item.disabled = true;
    if (el.required) item.required = true;
    if (el.getAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.getRootNode && el.getRootNode() !== document) item.shadow = true;
    items.push(item);
  }
  const fullText = (document.body ? document.body.innerText || '' : '').replace(/\\n{3,}/g, '\\n\\n');
  const text = fullText.slice(0, 12000);
  // Say when the page text or element list was cut, so the model scrolls or
  // reads further instead of assuming it saw the whole page.
  const more = {};
  if (fullText.length > text.length) more.textNote = 'Page text cut at 12000 of ' + fullText.length + ' characters; use read for the whole page as Markdown, or evaluate with document.body.innerText.slice(12000, 24000) (and so on).';
  if (skipped) more.elementsNote = skipped + ' more visible interactive elements were not numbered; scroll or use a selector/text locator.';
  const frames = document.querySelectorAll ? document.querySelectorAll('iframe').length : 0;
  if (frames) more.frames = frames;
  return { url: location.href, title: document.title, text, ...more, elements: items, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight } };
})()`;
}

// Kept for callers that evaluate the snapshot outside a session.
export const SNAPSHOT_JS = snapshotJs();

function locatorJs(args, refKey = DEFAULT_REF_KEY) {
  if (Number.isInteger(args.ref)) return '(() => { const r = window[' + JSON.stringify(refKey) + ']; const w = r && r.get(' + args.ref + '); const el = w && w.deref(); return el && el.isConnected ? el : null; })()';
  if (args.selector) return '(() => { const want = ' + JSON.stringify(String(args.selector)) + '; const direct = document.querySelector(want); if (direct) return direct; const stack = [...document.querySelectorAll("*")].filter((n) => n.shadowRoot).map((n) => n.shadowRoot); while (stack.length) { const root = stack.shift(); const hit = root.querySelector(want); if (hit) return hit; for (const n of root.querySelectorAll("*")) if (n.shadowRoot) stack.push(n.shadowRoot); } return null; })()';
  if (args.text) return '(() => { const want = ' + JSON.stringify(String(args.text).trim().toLowerCase()) + '; const all = [...document.querySelectorAll("a, button, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], summary, label")]; const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").toLowerCase(); return all.find((el) => label(el) === want) || all.find((el) => label(el).includes(want)) || null; })()';
  return null;
}

async function evaluate(page, expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
  const out = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true }, timeoutMs);
  if (out.exceptionDetails) throw new Error('Page error: ' + ((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text || 'exception').split('\n')[0]);
  return out.result ? out.result.value : undefined;
}

const settle = (ms = 300) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

function trimMap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }

async function setupPage(state, page, context) {
  const tab = { page, engine: state.engine, deniedUrls: new Set(), console: [], network: new Map(), inflight: new Set(), blockedNavigations: [], pendingNavigations: new Set(), url: 'about:blank', title: '', mainDocument: null };
  page.on('Runtime.consoleAPICalled', (p) => { tab.console.push({ type: p.type, text: (p.args || []).map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(' ').slice(0, 1000) }); if (tab.console.length > 200) tab.console.shift(); });
  page.on('Runtime.exceptionThrown', (p) => { const d = p.exceptionDetails || {}; tab.console.push({ type: 'exception', text: ((d.exception && d.exception.description) || d.text || 'Uncaught exception').slice(0, 1500) }); if (tab.console.length > 200) tab.console.shift(); });
  page.on('Log.entryAdded', (p) => { const e = p.entry || {}; if (e.level === 'error' || e.level === 'warning') { tab.console.push({ type: e.level, text: String(e.text || '').slice(0, 1000) + (e.url ? ' (' + e.url + ')' : '') }); if (tab.console.length > 200) tab.console.shift(); } });
  page.on('Network.requestWillBeSent', (p) => {
    if (!p.request) return;
    tab.network.set(p.requestId, { method: p.request.method, url: String(p.request.url).slice(0, 300), type: p.type });
    trimMap(tab.network, 300);
    tab.inflight.add(p.requestId);
    if (tab.inflight.size > 500) tab.inflight.clear();
  });
  page.on('Network.responseReceived', (p) => {
    const r = tab.network.get(p.requestId);
    const response = p.response || {};
    if (r) { r.status = response.status; r.mime = response.mimeType; }
    if (p.type === 'Document' && (!p.frameId || p.frameId === tab.mainFrameId)) {
      const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      tab.mainDocument = { url: response.url, status: response.status, mime: String(response.mimeType || headers['content-type'] || '').split(';')[0].trim().toLowerCase(), disposition: headers['content-disposition'] || '' };
    }
  });
  const done = (p) => { tab.inflight.delete(p.requestId); };
  page.on('Network.loadingFinished', done);
  page.on('Network.loadingFailed', (p) => { const r = tab.network.get(p.requestId); if (r) r.failed = p.errorText || 'failed'; done(p); });
  await Promise.all([page.send('Page.enable'), page.send('Runtime.enable'), page.send('Network.enable'), page.send('Log.enable').catch(() => {})]);
  const frameTree = await page.send('Page.getFrameTree');
  const root = frameTree && frameTree.frameTree && frameTree.frameTree.frame;
  tab.mainFrameId = root && root.id;
  if (root && root.url) tab.url = root.url;
  // CDP sends { frame, type }; keep the previous id if an event is malformed so a
  // bad event can never clear the main-frame identity and block every navigation.
  page.on('Page.frameNavigated', (params) => {
    const frame = params && params.frame ? params.frame : params;
    if (frame && !frame.parentId && frame.id) {
      tab.mainFrameId = frame.id;
      if (frame.url && !tab.deniedUrls.has(String(frame.url))) tab.url = String(frame.url);
    }
  });
  // Gate top-level document navigations from links, forms, redirects and page
  // scripts too—not only explicit browser.navigate tool calls.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  page.on('Fetch.requestPaused', (request) => {
    const pending = (async () => {
      const requestUrl = String(request.request.url || '');
      const isDocument = request.resourceType === 'Document';
      const isMainFrame = isDocument && tab.mainFrameId && request.frameId === tab.mainFrameId;
      const resume = () => {
        if (isMainFrame) tab.deniedUrls.delete(requestUrl);
        return page.send('Fetch.continueRequest', { requestId: request.requestId }).catch(() => {});
      };
      // A denied top-level navigation answers 204 No Content, which browsers treat
      // as "stay on the current page"; failing it would replace the page with an
      // error document and lose the agent's place. Everything else is failed.
      // Obscura blanks the page on a 204 but keeps it when the request fails. It can
      // still record a blocked URL as the current history entry afterwards, so the
      // tab remembers what it refused and liveUrl ignores those ghosts.
      if (isMainFrame) { tab.deniedUrls.add(requestUrl); if (tab.deniedUrls.size > 64) tab.deniedUrls.delete(tab.deniedUrls.values().next().value); }
      const fail = () => (isMainFrame && state.engine !== 'obscura'
        ? page.send('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 204, responseHeaders: [{ name: 'Cache-Control', value: 'no-store' }], body: '' })
        : Promise.reject(new Error('fail'))
      ).catch(() => page.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' })).catch(() => {})
        .then(() => (isMainFrame && state.engine === 'obscura' ? restoreLocation(tab) : undefined));
      const privateTarget = await isPrivateBrowserRequest(requestUrl);
      if (isDocument && !tab.mainFrameId) {
        tab.blockedNavigations.push({ url: requestUrl.slice(0, 1200), reason: 'The browser main frame could not be identified safely.' });
        await fail();
        return;
      }
      // Public subresources continue normally. Any request from page content to
      // localhost, private IPs, link-local, metadata, or internal hostnames is
      // approval-gated, including fetch/XHR, images, iframes and form targets.
      if (!isMainFrame && !privateTarget) { await resume(); return; }
      let policy;
      try { policy = browserNavigationPolicy(request.request.url); }
      catch (error) {
        tab.blockedNavigations.push({ url: String(request.request.url || '').slice(0, 1200), reason: error.message });
        await fail();
        return;
      }
      if (browserNavigationNeedsApproval(policy, state.approvedNavigations, { strictLocal: privateTarget || isMainFrame })) {
        const approved = await approve(context,
          (isMainFrame ? 'Follow top-level navigation to ' : 'Allow this page to contact a local/private network resource at ') + policy.approvalTarget + '?\n  ' + policy.url,
          { tool: 'browser', input: { action: 'navigate', url: policy.url, source: isMainFrame ? 'page-navigation' : 'page-private-resource' } });
        if (!approved) {
          tab.blockedNavigations.push({ url: policy.url.slice(0, 1200), reason: 'The user did not approve this navigation.' });
          await fail();
          return;
        }
        state.approvedNavigations.add(policy.approvalKey);
      }
      await resume();
    })().catch(async () => {
      tab.blockedNavigations.push({ url: String(request.request && request.request.url || '').slice(0, 1200), reason: 'Navigation approval could not be completed safely.' });
      await page.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    tab.pendingNavigations.add(pending);
    pending.then(
      () => tab.pendingNavigations.delete(pending),
      () => tab.pendingNavigations.delete(pending)
    );
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  return tab;
}

function visibleWanted(session, env) {
  if (wantsVirtualDisplay(session, env)) return true;
  if (env.OASIS_CHROME_HEADLESS) return env.OASIS_CHROME_HEADLESS === '0';
  return false;
}

function headlessFor(env) {
  return env.OASIS_CHROME_HEADLESS ? env.OASIS_CHROME_HEADLESS !== '0' : !(process.platform === 'darwin' || process.platform === 'win32' || env.DISPLAY || env.WAYLAND_DISPLAY);
}

function profileDirFor(session, env, engine) {
  // OASIS_BROWSER_PROFILE keeps cookies and storage (sign-ins) between sessions.
  // Each engine gets its own folder; subagents never share the main profile.
  const base = env.OASIS_BROWSER_PROFILE;
  if (!base || (session && session.parentSession)) return null;
  return path.join(path.resolve(base), engine);
}

async function launchFor(session, env, context, engine, { executable = null, capabilities = {} } = {}) {
  if (engine === 'obscura') {
    let exe = executable;
    if (!exe) {
      const decision = resolveEngine({ env: { ...env, OASIS_BROWSER_ENGINE: 'obscura' } });
      exe = decision.executable;
      if (!exe && decision.installable && obscuraAsset()) {
        const ok = env.OASIS_OBSCURA_AUTO_INSTALL === '1' || await approve(context, 'Download the Obscura browser engine (about 70 MB from github.com/h4ckf0r0day/obscura, SHA-256 checked) so the agent can browse?', { tool: 'browser', input: { action: 'engine', engine: 'obscura', source: 'install' } });
        if (ok) exe = (await installObscura({ env })).path;
      }
    }
    if (!exe) return null;
    return Browser.launch({ env, engine: 'obscura', executable: exe, profileDir: profileDirFor(session, env, 'obscura'), allowPrivateNetwork: Boolean(capabilities.privateNetwork), allowFileAccess: Boolean(capabilities.fileAccess), stealth: env.OASIS_BROWSER_STEALTH === '1' });
  }
  return Browser.launch({ env, engine: 'chrome', executable, headless: headlessFor(env), profileDir: profileDirFor(session, env, 'chrome') });
}

function downloadsDir(session, context) {
  const root = session.root || context.root;
  return root ? path.join(root, '.oasis', 'downloads') : path.join(os.tmpdir(), 'oasis-downloads');
}

async function newState(session, env, context, browser, { attached = false, approvedNavigations = null, recording = null, fallback = null } = {}) {
  const state = {
    browser,
    engine: browser.engine,
    tabs: [],
    active: 0,
    approvedNavigations: approvedNavigations || new Set(),
    evalApproved: false,
    attached,
    refKey: '__oasis_' + randomBytes(6).toString('hex'),
    recording: recording || (recordingEnabled(env) ? newRecording() : null),
    downloads: new Map(),
    fallback,
    startupMs: browser.startupMs || 0
  };
  // Chrome saves page-started downloads into a private folder; OASIS moves each
  // finished file into the workspace and reports it on the next action.
  if (browser.engine === 'chrome' && !attached) {
    state.chromeDownloadDir = path.join(browser.profile || os.tmpdir(), 'oasis-downloads');
    await mkdir(state.chromeDownloadDir, { recursive: true }).catch(() => {});
    browser.connection.on('Browser.downloadWillBegin', (p) => { state.downloads.set(p.guid, { url: String(p.url || '').slice(0, 1200), name: p.suggestedFilename || 'download', state: 'inProgress' }); });
    browser.connection.on('Browser.downloadProgress', (p) => {
      const item = state.downloads.get(p.guid);
      if (!item) return;
      item.state = p.state; item.bytes = p.receivedBytes || p.totalBytes || 0;
      if (p.state === 'completed') item.done = moveChromeDownload(session, context, state, p.guid, item).catch(() => {});
    });
    await browser.connection.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: state.chromeDownloadDir, eventsEnabled: true }).catch(() => {});
  }
  return state;
}

async function moveChromeDownload(session, context, state, guid, item) {
  const dir = downloadsDir(session, context);
  await mkdir(dir, { recursive: true });
  const target = await uniquePath(dir, safeFileName(item.name));
  await rename(path.join(state.chromeDownloadDir, guid), target);
  item.saved = relativeToRoot(session, context, target);
}

async function ensureBrowser(session, env, context) {
  const current = session.browserState;
  if (current && !current.browser.closed && current.tabs.length && !current.tabs[current.active].page.closed) return current;
  // Two tool calls arriving together must share one launch, not start two browsers.
  if (session.browserStarting) return session.browserStarting;
  session.browserStarting = (async () => {
    if (session.browserState) await closeBrowser(session, { keepRecording: true });
    const port = Number(env.OASIS_CHROME_PORT || 0);
    let browser;
    let attached = false;
    if (port) { browser = await Browser.attach(port); attached = true; }
    else {
      const wanted = session.browserEnginePreference || null;
      const decision = wanted ? { engine: wanted } : resolveEngine({ env, visible: visibleWanted(session, env) });
      browser = await launchFor(session, env, context, decision.engine, { executable: decision.executable || null });
      if (!browser && decision.engine === 'obscura') {
        browser = await launchFor(session, env, context, 'chrome').catch((error) => { throw new Error('No browser could be started. Install Obscura with `oasis browser install`, or install Chrome. (' + error.message + ')'); });
      }
    }
    const state = await newState(session, env, context, browser, { attached });
    session.browserState = state;
    let target = null;
    if (!attached) target = (await browser.pages())[0] || null;
    const page = target ? await browser.connect(target) : await browser.newPage('about:blank');
    state.tabs.push(await setupPage(state, page, context));
    return state;
  })();
  try { return await session.browserStarting; }
  catch (error) {
    if (session.browserState) await closeBrowser(session).catch(() => {});
    throw error;
  }
  finally { session.browserStarting = null; }
}

// Cookies (sign-ins) and open tabs move with the session when the engine changes
// or is restarted with a wider network boundary.
async function exportCookies(state) {
  const tab = state.tabs[state.active];
  for (const attempt of [
    () => state.browser.connection.send('Storage.getCookies', {}, null, 5000),
    () => tab && tab.page.send('Network.getAllCookies', {}, 5000),
    () => tab && tab.page.send('Network.getCookies', {}, 5000)
  ]) {
    try { const out = await attempt(); if (out && Array.isArray(out.cookies)) return out.cookies; } catch {}
  }
  return [];
}

async function importCookies(state, cookies) {
  if (!cookies.length) return;
  const clean = cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), ...(c.sameSite ? { sameSite: c.sameSite } : {}), ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}) }));
  try { await state.browser.connection.send('Storage.setCookies', { cookies: clean }, null, 5000); return; } catch {}
  const tab = state.tabs[0];
  if (tab) await tab.page.send('Network.setCookies', { cookies: clean }, 5000).catch(() => {});
}

async function restartBrowser(session, env, context, engine, { capabilities = {}, reason = '', reopen = true } = {}) {
  const old = session.browserState;
  const urls = old ? old.tabs.map((t) => t.url).filter((u) => u && /^https?:/.test(u)) : [];
  const active = old ? old.active : 0;
  const cookies = old ? await exportCookies(old) : [];
  const approved = old ? old.approvedNavigations : null;
  const recording = old ? old.recording : null;
  const evalApproved = old ? old.evalApproved : false;
  if (old) { session.browserState = null; for (const tab of old.tabs) { try { tab.page.close(); } catch {} } if (!old.attached) await old.browser.close().catch(() => {}); }
  const browser = await launchFor(session, env, context, engine, { capabilities });
  if (!browser) throw new Error('The ' + engine + ' engine is not available.');
  const state = await newState(session, env, context, browser, { approvedNavigations: approved, recording, fallback: reason ? { from: old ? old.engine : null, reason } : null });
  state.evalApproved = evalApproved;
  state.capabilities = capabilities;
  session.browserState = state;
  const first = (await browser.pages())[0] || null;
  const page = first ? await browser.connect(first) : await browser.newPage('about:blank');
  state.tabs.push(await setupPage(state, page, context));
  await importCookies(state, cookies);
  if (reopen) {
    for (const [i, url] of urls.entries()) {
      let tab = state.tabs[0];
      if (i > 0) { tab = await setupPage(state, await browser.newPage('about:blank'), context); state.tabs.push(tab); }
      await tab.page.send('Page.navigate', { url }, 45000).catch(() => {});
    }
    state.active = Math.min(active, state.tabs.length - 1);
    await waitForLoad(state.tabs[state.active].page, 10000);
  }
  return state;
}

export async function closeBrowser(session, { keepRecording = false } = {}) {
  const state = session && session.browserState;
  if (!state) return '';
  session.browserState = null;
  // Keep what the agent did: closing the browser saves the steps not saved yet.
  let saved = '';
  if (!keepRecording && state.recording && state.recording.frames.length && session.root) {
    saved = await saveRecording(session.root, state.recording).catch(() => '');
    if (saved) session.lastBrowserRecording = saved;
  }
  await Promise.all([...state.downloads.values()].map((d) => d.done).filter(Boolean)).catch(() => {});
  for (const tab of state.tabs) { try { tab.page.close(); } catch {} }
  if (!state.attached) await state.browser.close().catch(() => {});
  else { try { state.browser.connection.close(); } catch {} }
  return saved;
}

async function approve(context, message, meta) {
  if (context.autoApprove || context.ruleAllowed) return true;
  if (typeof context.approval !== 'function') return false;
  const answer = await context.approval(message, false, meta);
  return Boolean(answer);
}

async function waitForLoad(page, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    let ready = 'loading';
    try { ready = await evaluate(page, 'document.readyState', { awaitPromise: false, timeoutMs: 5000 }); } catch {}
    if (ready === 'complete' || ready === 'interactive' && Date.now() - started > 3000) return;
    if (Date.now() - started > timeoutMs || page.closed) return;
    await settle(100);
  }
}

// Pages that render after load (single-page apps, search results) are read once the
// network has been quiet for a moment, up to a short cap.
async function waitForQuiet(tab, maxMs = 2500, quietMs = 400) {
  const started = Date.now();
  let quietSince = tab.inflight.size ? 0 : Date.now();
  while (Date.now() - started < maxMs && !tab.page.closed) {
    if (tab.inflight.size) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return;
    await settle(50);
  }
}

async function waitForNavigationApprovals(tab) {
  // Drain decisions before returning from actions that may have triggered navigation.
  // A short quiet period captures CDP requestPaused events queued by the same turn.
  for (;;) {
    if (tab.pendingNavigations.size) {
      await Promise.all([...tab.pendingNavigations]);
      continue;
    }
    await settle(50);
    if (!tab.pendingNavigations.size) return;
  }
}

// Obscura does not pause redirect hops for interception, so a same-origin link that
// redirects to another site would not be asked about. After every action that can
// navigate, check where the main frame actually is; if the user does not approve
// that origin, leave it before anything else happens there.
async function checkLandedOrigin(state, tab, context) {
  if (state.engine !== 'obscura') return;
  const href = await liveUrl(tab);
  let policy;
  try { policy = browserNavigationPolicy(href); } catch { return; }
  if (policy.localBlank || state.approvedNavigations.has(policy.approvalKey)) return;
  const privateTarget = await isPrivateBrowserRequest(policy.url).catch(() => true);
  if (!browserNavigationNeedsApproval(policy, state.approvedNavigations, { strictLocal: privateTarget })) return;
  const ok = await approve(context, 'The page moved to ' + policy.approvalTarget + ' (a redirect). Stay there?\n  ' + policy.url, { tool: 'browser', input: { action: 'navigate', url: policy.url, source: 'page-redirect' } });
  if (ok) { state.approvedNavigations.add(policy.approvalKey); return; }
  tab.deniedUrls.add(policy.url);
  const back = await returnToPrevious(state, tab, (url) => url !== policy.url);
  tab.blockedNavigations.push({ url: policy.url.slice(0, 1200), reason: 'The user did not approve this redirect; ' + (back ? 'the tab went back to the previous page.' : 'the tab was cleared.') });
  if (!back) await tab.page.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
}

async function finishNavigation(state, tab, context, { loadMs = 15000 } = {}) {
  await waitForNavigationApprovals(tab);
  await waitForLoad(tab.page, loadMs);
  await waitForNavigationApprovals(tab);
  await checkLandedOrigin(state, tab, context);
}

async function resolveElement(page, args, refKey) {
  const locator = locatorJs(args, refKey);
  if (!locator) throw new Error('Give ref (from snapshot), selector or text.');
  const box = await evaluate(page, '(() => { const el = ' + locator + '; if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; let hit = document.elementFromPoint(x, y); while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint ? hit.shadowRoot.elementFromPoint(x, y) : null; if (!inner || inner === hit) break; hit = inner; } let reach = false; for (let n = el; n; n = n.parentNode || (n.host || null)) { if (n === hit) { reach = true; break; } } if (!reach && hit) { for (let n = hit; n; n = n.parentNode || n.host || null) { if (n === el) { reach = true; break; } } } const shadow = el.getRootNode && el.getRootNode() !== document; const cover = !reach && hit ? (hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + (hit.className && typeof hit.className === "string" ? "." + hit.className.trim().split(/\\s+/).slice(0, 2).join(".") : "")) : ""; return { x, y, w: r.width, h: r.height, tag: el.tagName.toLowerCase(), name: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 60), shadow, reach, cover, disabled: Boolean(el.disabled) }; })()');
  if (!box) throw new Error('No element matched' + (Number.isInteger(args.ref) ? ' ref ' + args.ref + '; take a new snapshot' : '') + '.');
  return { ...box, locator };
}

async function pressKey(page, name) {
  const info = KEYS[name] || (name.length === 1 ? { code: /[a-z]/i.test(name) ? 'Key' + name.toUpperCase() : /\d/.test(name) ? 'Digit' + name : '', keyCode: name.toUpperCase().charCodeAt(0), text: name } : null);
  if (!info) throw new Error('Unknown key ' + name + '. Use one of ' + Object.keys(KEYS).join(', ') + ' or a single character.');
  const key = info.key || name;
  await page.send('Input.dispatchKeyEvent', { type: info.text ? 'keyDown' : 'rawKeyDown', key, code: info.code, windowsVirtualKeyCode: info.keyCode, text: info.text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: info.code, windowsVirtualKeyCode: info.keyCode });
}

// The address the main frame is really at; event-tracked tab.url can lag. Obscura's
// location.href can name a request that was blocked while the old page stays
// (upstream #1628); its navigation history holds the committed entry.
async function liveUrl(tab) {
  if (tab.engine === 'obscura') {
    const history = await tab.page.send('Page.getNavigationHistory', {}, 3000).catch(() => null);
    const entry = history && Array.isArray(history.entries) ? history.entries[history.currentIndex] : null;
    if (entry && entry.url && !tab.deniedUrls.has(String(entry.url))) { tab.url = String(entry.url); return tab.url; }
    if (entry && entry.url) return tab.url;
  }
  try {
    const href = await evaluate(tab.page, 'location.href', { timeoutMs: 3000 });
    if (typeof href === 'string' && href) tab.url = href;
  } catch {}
  return tab.url;
}

// After a blocked navigation Obscura keeps the old document but reports the refused
// URL as its location, so relative links and forms would resolve against a page
// that never loaded (upstream #1628). Put the committed address back in place.
// Obscura also loads data: documents it was told not to; when the document itself
// was replaced, load the approved page again instead of relabelling the new one.
async function restoreLocation(tab) {
  const committed = String(tab.url || '');
  if (!/^https?:/i.test(committed)) return;
  const href = await evaluate(tab.page, 'location.href', { timeoutMs: 3000 }).catch(() => null);
  if (typeof href !== 'string' || href === committed) return;
  if (!/^https?:/i.test(href)) {
    await tab.page.send('Page.navigate', { url: committed }, 20000).catch(() => {});
    await waitForLoad(tab.page, 8000).catch(() => {});
    return;
  }
  await evaluate(tab.page, '(() => { const want = ' + JSON.stringify(committed) + '; try { history.replaceState(history.state, \"\", want); } catch {} return location.href; })()', { timeoutMs: 3000 }).catch(() => {});
}

function blockedList(tab) {
  const blockedNavigations = tab.blockedNavigations.splice(0);
  return blockedNavigations.length ? { blockedNavigations } : {};
}

// Give a download a link just started a moment to finish so the result can say
// where it was saved; bigger files keep going and are reported by a later action.
async function settleDownloads(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = [...state.downloads.values()];
    if (!items.some((item) => item.state === 'inProgress')) break;
    await settle(100);
  }
  await Promise.all([...state.downloads.values()].map((item) => item.done).filter(Boolean));
}

function finishedDownloads(state) {
  const list = [];
  for (const [guid, item] of state.downloads) {
    if (item.reported || item.state === 'inProgress' || (item.state === 'completed' && !item.saved)) continue;
    item.reported = true;
    list.push(item.saved ? { saved: item.saved, bytes: item.bytes || 0, url: item.url } : { url: item.url, failed: item.state });
    state.downloads.delete(guid);
  }
  return list.length ? { downloads: list } : {};
}

// --- downloads ---

export function safeFileName(raw, fallback = 'download') {
  let name = String(raw || '').split(/[\\/]/).pop() || '';
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = '_' + name;
  if (!name) name = fallback;
  if (name.length > 180) { const ext = path.extname(name).slice(0, 20); name = name.slice(0, 180 - ext.length) + ext; }
  return name;
}

export function fileNameFromDisposition(header) {
  const value = String(header || '');
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(value);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {} }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(value);
  return plain ? (plain[2] !== undefined ? plain[2] : plain[1]).trim() : '';
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i ? base + ' (' + i + ')' + ext : name);
    try { await stat(candidate); } catch { return candidate; }
  }
  return path.join(dir, base + '-' + randomBytes(4).toString('hex') + ext);
}

function relativeToRoot(session, context, file) {
  const root = session.root || context.root;
  return root ? path.relative(root, file) : file;
}

function downloadLimit(env) {
  const mb = Number(env.OASIS_BROWSER_DOWNLOAD_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 512) * 1024 * 1024;
}

/**
 * Fetch a file the way the page would (its cookies, user agent and referrer) and
 * save it under .oasis/downloads. Every redirect hop is checked against the same
 * private-network rule as page requests, and the size is capped.
 */
export async function downloadWithPageCookies({ url, page, state, session, context, env, filename = '', fetchImpl = globalThis.fetch }) {
  let current = url;
  const limit = downloadLimit(env);
  let userAgent = '';
  try { userAgent = (await state.browser.connection.send('Browser.getVersion', {}, null, 5000)).userAgent || ''; } catch {}
  let referrer = '';
  try { referrer = await evaluate(page, 'location.href', { timeoutMs: 5000 }); } catch {}
  for (let hop = 0; hop <= 10; hop++) {
    const policy = browserNavigationPolicy(current);
    if (!/^https?:$/.test(policy.protocol)) throw new Error('Only http and https files can be downloaded.');
    const privateTarget = await isPrivateBrowserRequest(policy.url);
    if (browserNavigationNeedsApproval(policy, state.approvedNavigations, { strictLocal: privateTarget })) {
      if (!(await approve(context, 'Download a file from ' + policy.approvalTarget + '?\n  ' + policy.url, { tool: 'browser', input: { action: 'download', url: policy.url } }))) throw new Error('The user did not approve downloading from ' + policy.approvalTarget + '.');
      state.approvedNavigations.add(policy.approvalKey);
    }
    let cookieHeader = '';
    try {
      const { cookies = [] } = await page.send('Network.getCookies', { urls: [policy.url] }, 5000);
      cookieHeader = cookies.filter((c) => c && c.name).map((c) => c.name + '=' + c.value).join('; ');
    } catch {}
    const headers = { accept: '*/*', ...(userAgent ? { 'user-agent': userAgent } : {}), ...(cookieHeader ? { cookie: cookieHeader } : {}), ...(referrer && /^https?:/.test(referrer) ? { referer: referrer } : {}) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    timer.unref?.();
    let response;
    try { response = await fetchImpl(policy.url, { headers, redirect: 'manual', signal: controller.signal }); }
    catch (error) { clearTimeout(timer); throw new Error('Download failed: ' + error.message); }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      clearTimeout(timer);
      try { await response.body?.cancel(); } catch {}
      current = new URL(response.headers.get('location'), policy.url).href;
      continue;
    }
    if (!response.ok || !response.body) { clearTimeout(timer); throw new Error('Download failed with HTTP ' + response.status + '.'); }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > limit) { clearTimeout(timer); try { await response.body.cancel(); } catch {} throw new Error('The file is larger than the download limit (' + Math.round(limit / 1048576) + ' MB; OASIS_BROWSER_DOWNLOAD_MAX_MB changes it).'); }
    const dir = downloadsDir(session, context);
    await mkdir(dir, { recursive: true });
    const urlName = decodeURIComponent(new URL(policy.url).pathname.split('/').pop() || '');
    const name = safeFileName(filename || fileNameFromDisposition(response.headers.get('content-disposition')) || urlName, 'download');
    const target = await uniquePath(dir, name);
    const partial = target + '.part-' + randomBytes(3).toString('hex');
    const hash = createHash('sha256');
    let bytes = 0;
    const out = createWriteStream(partial, { flags: 'wx' });
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error('The file is larger than the download limit (' + Math.round(limit / 1048576) + ' MB; OASIS_BROWSER_DOWNLOAD_MAX_MB changes it).');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
      await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
      await rename(partial, target);
    } catch (error) {
      out.destroy();
      await rm(partial, { force: true }).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
    return { saved: relativeToRoot(session, context, target), bytes, mime: String(response.headers.get('content-type') || '').split(';')[0], sha256: hash.digest('hex'), url: policy.url };
  }
  throw new Error('The download redirected too many times.');
}

const PAGE_MIME = /^(?:text\/(?:html|plain|xml|css|javascript|csv|markdown)|application\/(?:xhtml\+xml|xml|json|javascript|ld\+json|rss\+xml|atom\+xml)|image\/svg\+xml|)$/;

// Obscura opens an attachment as a page instead of saving it. When the main
// document turns out to be a file, save it the same way `download` does.
async function saveDocumentIfFile(state, tab, session, context, env) {
  // Chrome downloads attachments itself (Browser.setDownloadBehavior); saving the
  // document again here would store every file twice.
  if (state.engine !== 'obscura') return null;
  const doc = tab.mainDocument;
  if (!doc || !doc.url || !/^https?:/.test(doc.url)) return null;
  const attachment = /^\s*attachment/i.test(doc.disposition);
  if (!attachment && PAGE_MIME.test(doc.mime) && !/^image\/(?!svg)|^video\/|^audio\/|^application\/(?:pdf|zip|octet-stream)/.test(doc.mime)) return null;
  if (!attachment && /^image\//.test(doc.mime)) return null;
  tab.mainDocument = null;
  let saved;
  try { saved = await downloadWithPageCookies({ url: doc.url, page: tab.page, state, session, context, env, filename: fileNameFromDisposition(doc.disposition) }); }
  catch (error) { saved = { error: error.message }; }
  // Obscura shows the file as a page; a browser would stay where the link was.
  if (state.engine === 'obscura') await returnToPrevious(state, tab);
  return saved;
}

// Step an Obscura tab back to the page before the current one (after it showed a
// file as a page, or landed somewhere the user refused). True when it got there.
async function returnToPrevious(state, tab, accept = () => true) {
  const history = await tab.page.send('Page.getNavigationHistory').catch(() => null);
  if (!history || !Array.isArray(history.entries)) return false;
  let entry = null;
  for (let i = history.currentIndex - 1; i >= 0; i--) {
    const candidate = history.entries[i];
    const url = String(candidate && candidate.url || '');
    if (!/^https?:/i.test(url)) break;
    if (!tab.deniedUrls.has(url) && accept(url)) { entry = candidate; break; }
  }
  if (!entry) return false;
  const widened = state.capabilities && (state.capabilities.privateNetwork || state.capabilities.fileAccess);
  try {
    if (widened) {
      // The previous page was already approved for this tab.
      await tab.page.send('Page.navigate', { url: entry.url }, 20000);
    } else {
      await tab.page.send('Fetch.disable').catch(() => {});
      try { await tab.page.send('Page.navigateToHistoryEntry', { entryId: entry.id }, 20000); }
      finally { await tab.page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }).catch(() => {}); }
    }
    await waitForLoad(tab.page, 8000);
    tab.mainDocument = null;
    return (await liveUrl(tab)) === entry.url;
  } catch { return false; }
}

// --- engine health ---

// Obscura is young: some pages come back empty or never finish. Those switch the
// session to Chrome (when installed) and are retried there, with cookies carried over.
async function pageHealth(page) {
  try {
    return await evaluate(page, '(() => { const b = document.body; const text = b ? (b.innerText || "").trim().length : 0; const els = document.querySelectorAll("a[href],button,input,textarea,select,img,video,canvas,svg,iframe").length; const t = document.title || \"\"; const challenge = /^(just a moment|attention required|checking your browser|please wait|access denied|verify you are human|one more step)/i.test(t.trim()) || document.querySelector(\"#challenge-form, #cf-challenge-running, .cf-turnstile, #px-captcha, iframe[src*=\\\"captcha\\\"], iframe[src*=\\\"challenges.cloudflare\\\"]\") ? (t.trim() || \"challenge page\").slice(0, 60) : \"\"; return { text, els, html: document.documentElement ? document.documentElement.outerHTML.length : 0, challenge }; })()', { timeoutMs: 8000 });
  } catch { return null; }
}

function fallbackAllowed(state, env) {
  return state.engine === 'obscura' && !state.attached && env.OASIS_BROWSER_FALLBACK !== '0' && resolveEngine({ env: { ...env, OASIS_BROWSER_ENGINE: 'chrome' } }).executable;
}

export async function executeBrowserTool(args, context = {}) {
  const session = context.session || context;
  // One action at a time per session: parallel tool calls used to interleave on the
  // same tab (two navigations racing, a click landing on the wrong page).
  const previous = session.browserQueue || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  session.browserQueue = previous.then(() => mine);
  await previous.catch(() => {});
  try { return await runQueued(args, context, session); }
  finally { release(); }
}

async function runQueued(args, context, session) {
  const action = String(args.action || '');
  if (action === 'close') { const recording = await closeBrowser(session); return { closed: true, ...(recording ? { recording } : {}) }; }
  if (action === 'recording') {
    const state = session.browserState;
    if (!state || !state.recording) return { error: recordingEnabled(context.env || process.env) ? 'Nothing recorded yet: open a page first.' : 'Recording is off (OASIS_BROWSER_RECORD=0).' };
    if (!state.recording.frames.length) return { error: 'No new steps since the last saved recording.' };
    const saved = await saveRecording(session.root || context.root, state.recording);
    if (!saved) return { error: 'Could not save the recording (no workspace folder).' };
    session.lastBrowserRecording = saved;
    return { recording: saved, hint: 'A self-contained HTML player. Open it in a browser to replay each step.' };
  }
  if (!BROWSER_ACTIONS.includes(action)) throw new Error('Unknown browser action ' + action + '.');
  const result = await runBrowserAction(args, context, session, action);
  const state = session.browserState;
  if (state && state.recording && RECORDED_ACTIONS.has(action) && result && !result.error) {
    const tab = state.tabs[state.active];
    if (tab && !tab.page.closed) await addFrame(state.recording, stepCaption(action, args, result), () => capturePage(tab.page, evaluate));
  }
  if (state && state.engine === 'obscura' && result && result.blockedNavigations) {
    const tab = state.tabs[state.active];
    if (tab && !tab.page.closed) await restoreLocation(tab);
  }
  if (state && result && typeof result === 'object' && !Array.isArray(result)) Object.assign(result, finishedDownloads(state));
  return result;
}

async function runBrowserAction(args, context, session, action) {
  let env = context.env || process.env;
  // An agent with its own virtual screen gets its browser on that screen (agent environments).
  if (wantsVirtualDisplay(session, env) && !(session.browserState && session.browserState.attached)) {
    env = await agentDisplayEnv(session, env) || env;
  }
  if (action === 'engine') return engineAction(args, context, session, env);
  let state = await ensureBrowser(session, env, context);
  let tab = state.tabs[state.active];
  let page = tab.page;
  switch (action) {
    case 'navigate': {
      const policy = browserNavigationPolicy(args.url);
      const url = policy.url;
      if (browserNavigationNeedsApproval(policy, state.approvedNavigations, { strictLocal: false })) {
        if (!(await approve(context, 'Open ' + policy.approvalTarget + ' in the browser?\n  ' + url, { tool: 'browser', input: args }))) {
          return { error: 'The user did not approve opening ' + policy.approvalTarget + '.' };
        }
      }
      state.approvedNavigations.add(policy.approvalKey);
      // Obscura refuses private addresses and file: URLs at the engine level. Once the
      // user has opened one of those on purpose, restart it with that boundary lifted
      // (cookies and tabs carry over); OASIS's per-request approvals still apply.
      if (state.engine === 'obscura' && !state.attached) {
        const caps = { ...(state.capabilities || {}) };
        let widen = false;
        if (policy.protocol === 'file:' && !caps.fileAccess) { caps.fileAccess = true; widen = true; }
        if (/^https?:$/.test(policy.protocol) && !caps.privateNetwork && await isPrivateBrowserRequest(url).catch(() => true)) { caps.privateNetwork = true; widen = true; }
        if (widen) { state = await restartBrowser(session, env, context, 'obscura', { capabilities: caps }); tab = state.tabs[state.active]; page = tab.page; }
      }
      return navigateTab(state, tab, url, args, context, session, env);
    }
    case 'snapshot': {
      const snap = await evaluate(page, snapshotJs(state.refKey));
      if (snap && state.engine === 'obscura') snap.url = await liveUrl(tab);
      return snap;
    }
    case 'read': {
      const { htmlToMarkdown } = await import('./html-markdown.mjs');
      const doc = await evaluate(page, '({ url: location.href, title: document.title, html: document.documentElement ? document.documentElement.outerHTML : "" })');
      const html = String(doc && doc.html || '');
      const converted = await htmlToMarkdown(html.length > 4_000_000 ? html.slice(0, 4_000_000) : html, { url: doc && doc.url });
      const limit = Math.max(2000, Math.min(200000, Number(args.amount) || 40000));
      const markdown = String(converted.markdown || '');
      const out = { url: doc && doc.url, title: converted.title || (doc && doc.title) || '', markdown: markdown.slice(0, limit) };
      if (markdown.length > limit) out.note = 'Cut at ' + limit + ' of ' + markdown.length + ' characters; pass amount for more.';
      if (converted.degraded) out.degraded = converted.degraded;
      return out;
    }
    case 'click': {
      const box = await resolveElement(page, args, state.refKey);
      const before = await liveUrl(tab);
      const downloadsBefore = state.downloads.size;
      let note;
      // Obscura's hit testing stops at shadow hosts, so a click on an element inside
      // a shadow root would land on the host; activate the element directly instead.
      // A zero-size box has no point to press (hidden element, or Obscura has not laid
      // the page out yet); activating it directly beats clicking the page corner.
      const flat = !(box.w > 0 && box.h > 0);
      if ((box.shadow && state.engine === 'obscura') || flat) {
        await evaluate(page, '(() => { const el = ' + box.locator + '; if (el) el.click(); return true; })()');
        if (flat && state.engine !== 'obscura') note = 'The element has no visible size, so it was activated directly rather than clicked.';
      } else {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
        if (!box.reach && box.cover) note = 'Another element (' + box.cover + ') covers this one, so the click landed on it. Close the overlay or scroll, then try again.';
      }
      await waitForNavigationApprovals(tab);
      await settle(300);
      // Slow hosts can start a link navigation after the first settle; give a followed link a short grace period.
      for (let waited = 0; box.tag === 'a' && waited < 2000 && !tab.blockedNavigations.length; waited += 100) {
        if (tab.url !== before || state.downloads.size > downloadsBefore) break;
        await settle(100);
        await waitForNavigationApprovals(tab);
      }
      if (state.downloads.size > downloadsBefore) await settleDownloads(state, 15000);
      else await finishNavigation(state, tab, context, { loadMs: 5000 });
      if (tab.url !== before) await waitForQuiet(tab, 1500);
      const saved = await saveDocumentIfFile(state, tab, session, context, env);
      return { clicked: box.tag + (box.name ? ' "' + box.name + '"' : ''), url: await liveUrl(tab), ...(box.disabled ? { disabled: true } : {}), ...(note ? { note } : {}), ...(saved ? { download: saved } : {}), ...blockedList(tab) };
    }
    case 'hover': {
      const box = await resolveElement(page, args, state.refKey);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
      // Obscura does not turn mouse moves into pointer events yet; fire them in the page.
      if (state.engine === 'obscura') await evaluate(page, '(() => { const el = ' + box.locator + '; if (!el) return false; for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) el.dispatchEvent(new (t.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent)(t, { bubbles: !t.endsWith("enter"), composed: true, clientX: ' + box.x + ', clientY: ' + box.y + ' })); return true; })()').catch(() => {});
      await settle(250);
      return { hovered: box.tag + (box.name ? ' "' + box.name + '"' : '') };
    }
    case 'type': {
      const locator = locatorJs(args, state.refKey);
      const text = String(args.text || '');
      if (locator) {
        // Clearing selects the existing text so the typed text replaces it the way a
        // person's typing would; frameworks that track input events see the change.
        const ok = await evaluate(page, '(() => { const el = ' + locator + '; if (!el) return false; el.scrollIntoView({ block: "center" }); el.focus(); ' + (args.clear ? 'if (typeof el.select === "function" && "value" in el) el.select(); else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }' : 'if ("value" in el && typeof el.setSelectionRange === "function") { try { const n = String(el.value).length; el.setSelectionRange(n, n); } catch {} }') + ' return true; })()');
        if (!ok) throw new Error('No element matched' + (Number.isInteger(args.ref) ? ' ref ' + args.ref + '; take a new snapshot' : '') + '.');
        if (args.clear && !text) await pressKey(page, 'Backspace');
      }
      if (text) await page.send('Input.insertText', { text });
      // Engines that ignore the selection on insert leave the old text in place;
      // fix the value up so clear always means clear.
      if (locator && args.clear && text) {
        await evaluate(page, '(() => { const el = ' + locator + '; if (!el || !("value" in el)) return; const want = ' + JSON.stringify(text) + '; if (el.value !== want) { const proto = Object.getPrototypeOf(el); const desc = Object.getOwnPropertyDescriptor(proto, "value"); if (desc && desc.set) desc.set.call(el, want); else el.value = want; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); } })()').catch(() => {});
      }
      let saved = null;
      if (args.submit) {
        const before = await liveUrl(tab);
        await pressKey(page, 'Enter');
        await waitForNavigationApprovals(tab);
        await settle(400);
        // Obscura does not submit a form on Enter in every case; submit it the way the
        // browser would (requestSubmit runs validation and submit handlers).
        if (state.engine === 'obscura' && locator && (await liveUrl(tab)) === before && !tab.pendingNavigations.size) {
          await evaluate(page, '(() => { const el = ' + locator + '; const form = el && el.form; if (form && typeof form.requestSubmit === "function") { form.requestSubmit(); return true; } return false; })()').catch(() => {});
          await settle(300);
        }
        await finishNavigation(state, tab, context, { loadMs: 8000 });
        await waitForQuiet(tab, 2000);
        saved = await saveDocumentIfFile(state, tab, session, context, env);
      }
      return { typed: text.length + ' characters', submitted: Boolean(args.submit), ...(args.submit ? { url: await liveUrl(tab) } : {}), ...(saved ? { download: saved } : {}), ...blockedList(tab) };
    }
    case 'select': {
      const locator = locatorJs(args, state.refKey);
      if (!locator) throw new Error('Give ref (from snapshot) or selector for the dropdown.');
      const want = String(args.value ?? args.text ?? '');
      const out = await evaluate(page, '(() => { const el = ' + locator + '; if (!el) return { error: "No element matched" }; if (el.tagName !== "SELECT") return { error: "That element is a " + el.tagName.toLowerCase() + ", not a dropdown; click it and pick the option instead." }; const want = ' + JSON.stringify(want) + '.trim().toLowerCase(); const opts = [...el.options]; const opt = opts.find((o) => o.value.toLowerCase() === want) || opts.find((o) => (o.label || o.text).trim().toLowerCase() === want) || opts.find((o) => (o.label || o.text).trim().toLowerCase().includes(want)); if (!opt) return { error: "No option matches", options: opts.slice(0, 40).map((o) => (o.label || o.text).trim()) }; el.focus(); opt.selected = true; el.value = opt.value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { selected: (opt.label || opt.text).trim(), value: opt.value }; })()');
      await settle(150);
      await waitForNavigationApprovals(tab);
      return { ...out, ...blockedList(tab) };
    }
    case 'press': {
      const before = await liveUrl(tab);
      await pressKey(page, String(args.key || 'Enter'));
      await settle(250);
      await waitForNavigationApprovals(tab);
      const moved = tab.pendingNavigations.size > 0 || (await liveUrl(tab)) !== before;
      if (moved) await finishNavigation(state, tab, context, { loadMs: 8000 });
      return { pressed: args.key || 'Enter', ...(moved ? { url: await liveUrl(tab) } : {}), ...blockedList(tab) };
    }
    case 'scroll': {
      const amount = Math.max(1, Math.min(20000, Number(args.amount) || 700));
      const y = await evaluate(page, 'window.scrollBy(0, ' + (args.direction === 'up' ? -amount : amount) + '); Math.round(scrollY)');
      await settle(150);
      return { scrollY: y };
    }
    case 'wait': {
      if (args.text) {
        const want = JSON.stringify(String(args.text));
        const limit = Math.min(30000, Number(args.ms) || 10000);
        const started = Date.now();
        while (Date.now() - started < limit) {
          if (await evaluate(page, 'document.body && document.body.innerText.includes(' + want + ')').catch(() => false)) return { found: true, after_ms: Date.now() - started };
          await settle(200);
        }
        return { found: false, waited_ms: limit };
      }
      const ms = Math.min(30000, Math.max(0, Number(args.ms) || 1000));
      await settle(ms);
      return { waited_ms: ms };
    }
    case 'screenshot': {
      let clip;
      if (Number.isInteger(args.ref) || args.selector) {
        const box = await resolveElement(page, args, state.refKey);
        const scroll = await evaluate(page, '({ x: scrollX, y: scrollY })');
        clip = { x: Math.max(0, box.x - box.w / 2 + scroll.x), y: Math.max(0, box.y - box.h / 2 + scroll.y), width: Math.max(1, Math.min(box.w, 4000)), height: Math.max(1, Math.min(box.h, 8000)), scale: 1 };
      } else if (args.full_page) {
        clip = await evaluate(page, '({ x: 0, y: 0, width: Math.max(1, Math.min(document.documentElement.scrollWidth, 4000)), height: Math.max(1, Math.min(document.documentElement.scrollHeight, 8000)), scale: 1 })');
      }
      const shot = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, 60000);
      const result = { screenshot: 'attached', url: await liveUrl(tab), bytes: Math.round(shot.data.length * 0.75), engine: state.engine };
      if (state.engine === 'obscura') result.note = 'Rendered by Obscura; if the layout looks wrong, switch with engine {engine: "chrome"} for a pixel-accurate view.';
      Object.defineProperty(result, 'imageData', { value: { mediaType: 'image/png', data: shot.data }, enumerable: false });
      return result;
    }
    case 'evaluate': {
      const expression = String(args.expression || '');
      if (!expression) throw new Error('evaluate needs an expression.');
      if (!state.evalApproved) {
        if (!(await approve(context, 'Run JavaScript in the browser page?\n  ' + expression.slice(0, 1200), { tool: 'browser', input: args }))) return { error: 'The user did not approve running page JavaScript.' };
      }
      const value = await evaluate(page, expression);
      await waitForNavigationApprovals(tab);
      const text = value === undefined ? 'undefined' : JSON.stringify(value);
      return { value: text && text.length > 20000 ? text.slice(0, 20000) + '… (truncated)' : text, ...blockedList(tab) };
    }
    case 'back':
    case 'forward': {
      const history = await page.send('Page.getNavigationHistory').catch(() => null);
      const before = await liveUrl(tab);
      if (history && Array.isArray(history.entries)) {
        const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
        if (!entry) return { error: 'There is no page to go ' + action + ' to.', url: before };
        if (state.engine === 'obscura') {
          // Obscura stalls history navigation while requests are intercepted. Its own
          // connect-time block still stops private-network requests in a process
          // started without that capability, so pause interception just for the
          // history step there; with wider capabilities, reopen the entry through
          // the normal approval path instead.
          const widened = state.capabilities && (state.capabilities.privateNetwork || state.capabilities.fileAccess);
          if (widened || !/^https?:/i.test(String(entry.url || ''))) return runBrowserAction({ action: 'navigate', url: entry.url }, context, session, 'navigate');
          await page.send('Fetch.disable').catch(() => {});
          try { await page.send('Page.navigateToHistoryEntry', { entryId: entry.id }, 20000); }
          finally { await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }).catch(() => {}); }
        } else {
          await page.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        }
      } else {
        await evaluate(page, action === 'back' ? 'history.back()' : 'history.forward()');
      }
      await settle(300);
      await finishNavigation(state, tab, context, { loadMs: 10000 });
      return { url: await liveUrl(tab), title: await evaluate(page, 'document.title').catch(() => ''), ...blockedList(tab) };
    }
    case 'reload': {
      await page.send('Page.reload', { ignoreCache: false });
      await settle(200);
      await finishNavigation(state, tab, context, { loadMs: 15000 });
      return { url: await liveUrl(tab), title: await evaluate(page, 'document.title').catch(() => ''), ...blockedList(tab) };
    }
    case 'download': {
      let url = args.url;
      if (!url) {
        const locator = locatorJs(args, state.refKey);
        if (!locator) throw new Error('download needs a url or the ref of a link.');
        url = await evaluate(page, '(() => { const el = ' + locator + '; return el ? (el.href || el.src || el.getAttribute("href") || "") : ""; })()');
        if (!url) throw new Error('That element has no link to download.');
      }
      return downloadWithPageCookies({ url: new URL(String(url), tab.url && /^https?:/.test(tab.url) ? tab.url : undefined).href, page, state, session, context, env, filename: args.filename || '' });
    }
    case 'console': {
      const messages = tab.console.slice(-100);
      tab.console = [];
      return { messages, note: messages.length ? undefined : 'No console messages since the last check.' };
    }
    case 'network': {
      const all = [...tab.network.values()];
      const failed = all.filter((r) => r.failed || r.status >= 400);
      return { failed, recent: all.filter((r) => !failed.includes(r)).slice(-60), total: all.length };
    }
    case 'tabs': {
      const list = [];
      for (const [i, t] of state.tabs.entries()) {
        let title = '';
        try { title = await evaluate(t.page, 'document.title', { timeoutMs: 3000 }); } catch {}
        list.push({ index: i, active: i === state.active, url: t.url, title });
      }
      return { tabs: list, engine: state.engine };
    }
    case 'new_tab': {
      const created = await state.browser.newPage('about:blank');
      state.tabs.push(await setupPage(state, created, context));
      state.active = state.tabs.length - 1;
      if (args.url) return runBrowserAction({ action: 'navigate', url: args.url }, context, session, 'navigate');
      return { index: state.active };
    }
    case 'switch_tab': {
      const index = Number(args.index);
      if (!Number.isInteger(index) || !state.tabs[index]) throw new Error('No tab ' + args.index + '.');
      state.active = index;
      await state.tabs[index].page.send('Page.bringToFront').catch(() => {});
      return { active: index, url: state.tabs[index].url };
    }
    case 'close_tab': {
      if (state.tabs.length === 1) { await closeBrowser(session); return { closed: true }; }
      const [removed] = state.tabs.splice(state.active, 1);
      await state.browser.closePage(removed.page.target.id);
      removed.page.close();
      state.active = Math.max(0, state.active - 1);
      return { active: state.active, tabs: state.tabs.length };
    }
    default:
      throw new Error('Unknown browser action ' + action + '.');
  }
}

async function navigateTab(state, tab, url, args, context, session, env) {
  const page = tab.page;
  const started = Date.now();
  tab.mainDocument = null;
  const loaded = page.once('Page.loadEventFired', 20000);
  let nav;
  try { nav = await page.send('Page.navigate', { url }, 45000); }
  catch (error) {
    if (fallbackAllowed(state, env)) return fallBack(session, env, context, url, 'Obscura could not open the page (' + error.message + ')', args);
    throw error;
  }
  const chromeDownload = nav.errorText && /ERR_ABORTED/.test(nav.errorText) && state.engine === 'chrome' && [...state.downloads.values()].some((d) => d.url === url || d.state === 'inProgress');
  if (nav.errorText && !chromeDownload) {
    if (fallbackAllowed(state, env) && !/ERR_BLOCKED_BY_CLIENT|BlockedByClient/i.test(nav.errorText)) return fallBack(session, env, context, url, 'Obscura could not open the page (' + nav.errorText + ')', args);
    return { error: 'Navigation failed: ' + nav.errorText, url, ...blockedList(tab) };
  }
  if (chromeDownload) {
    for (let waited = 0; waited < 60000 && [...state.downloads.values()].some((d) => d.state === 'inProgress'); waited += 200) await settle(200);
    await Promise.all([...state.downloads.values()].map((d) => d.done).filter(Boolean));
    return { url: tab.url, note: 'The link started a download.', ...finishedDownloads(state) };
  }
  await waitForNavigationApprovals(tab);
  if (tab.blockedNavigations.length) {
    return { url: await liveUrl(tab).catch(() => url), title: await evaluate(page, 'document.title').catch(() => ''), ...blockedList(tab), hint: 'A page-initiated navigation was blocked pending approval.' };
  }
  // once() gives up after 20 s by itself; a separate 20 s sleep in a race would
  // outlive the call and hold the process open after the browser closed.
  const loadEvent = await loaded;
  await waitForLoad(page);
  await waitForNavigationApprovals(tab);
  await checkLandedOrigin(state, tab, context);
  await waitForQuiet(tab, 2500);
  const saved = await saveDocumentIfFile(state, tab, session, context, env);
  if (saved) return { url, download: saved, note: 'The address is a file, so it was saved instead of shown.', ...blockedList(tab) };
  if (state.engine === 'obscura' && /^https?:/.test(url) && fallbackAllowed(state, env)) {
    const health = await pageHealth(page);
    const empty = !health || (health.text === 0 && health.els === 0);
    if (!loadEvent && empty) return fallBack(session, env, context, url, 'Obscura did not finish loading the page', args);
    if (empty && health && health.html > 0) return fallBack(session, env, context, url, 'Obscura returned an empty page', args);
    if (health && health.challenge) return fallBack(session, env, context, url, 'the site showed Obscura a bot check (' + health.challenge + ')', args);
  }
  const blocked = blockedList(tab);
  return { url: await liveUrl(tab).catch(() => url), title: await evaluate(page, 'document.title').catch(() => ''), ...(state.fallback && state.fallback.fresh ? { engine: state.engine, fellBack: state.fallback.reason } : {}), ...(Date.now() - started > 0 ? { load_ms: Date.now() - started } : {}), ...blocked, hint: 'Take a snapshot (or read for the page as Markdown) to see the page and get element refs.' };
}

async function fallBack(session, env, context, url, reason, args) {
  const state = await restartBrowser(session, env, context, 'chrome', { reason, reopen: false });
  session.browserEnginePreference = 'chrome';
  state.fallback = { from: 'obscura', reason, fresh: true };
  const result = await navigateTab(state, state.tabs[state.active], url, args, context, session, env);
  state.fallback.fresh = false;
  return { ...result, engine: 'chrome', fellBack: reason };
}

async function engineAction(args, context, session, env) {
  const state = session.browserState;
  const wanted = args.engine ? String(args.engine).toLowerCase() : '';
  if (!wanted) {
    const preferred = resolveEngine({ env, visible: visibleWanted(session, env) });
    return { engine: state ? state.engine : null, open: Boolean(state), next: session.browserEnginePreference || preferred.engine, reason: state && state.fallback ? state.fallback.reason : preferred.reason, ...(state && state.startupMs ? { startup_ms: state.startupMs } : {}) };
  }
  if (!['obscura', 'chrome'].includes(wanted)) throw new Error('engine must be obscura or chrome.');
  if (state && state.attached) return { error: 'The browser is attached to your own Chrome (OASIS_CHROME_PORT); the engine cannot be switched.' };
  session.browserEnginePreference = wanted;
  if (!state) return { engine: wanted, open: false, note: 'The next browser action starts ' + wanted + '.' };
  if (state.engine === wanted) return { engine: wanted, open: true };
  const next = await restartBrowser(session, env, context, wanted, { capabilities: state.capabilities || {}, reason: 'switched by the agent' });
  return { engine: next.engine, open: true, tabs: next.tabs.map((t, index) => ({ index, url: t.url })), note: 'Cookies and open pages moved to ' + wanted + '.' };
}
