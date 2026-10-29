// Browser tool (Claude Code's Chrome integration, `--chrome` / `/chrome`): the agent drives a
// real Chrome/Chromium/Edge through the DevTools Protocol to open pages, read them, click,
// type, take screenshots, and read console and network activity. Oasis launches its own
// browser with a throwaway profile, or attaches to yours (OASIS_CHROME_PORT) so it can use
// pages you are signed in to. Visiting a new site and running page JavaScript ask first
// unless the call is auto-approved.
import { Browser, findChrome } from './cdp.mjs';

export const BROWSER_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'browser',
    description: 'Drive a real Chrome browser. Actions: navigate {url}; snapshot (page text plus numbered interactive elements; use their ref in later calls); click {ref|selector|text}; type {ref|selector, text, clear?, submit?}; press {key, e.g. Enter, Tab, Escape, ArrowDown}; scroll {direction: up|down, amount?}; wait {text?|ms?}; screenshot {full_page?} (you see the image); evaluate {expression} (page JavaScript); console (recent console messages and errors); network (recent requests, failures first); tabs; new_tab {url?}; switch_tab {index}; close_tab; close. Take a snapshot after navigating or after the page changes, then act on refs. Use it to check web UIs you build, reproduce bugs and read pages that need JavaScript.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'wait', 'screenshot', 'evaluate', 'console', 'network', 'tabs', 'new_tab', 'switch_tab', 'close_tab', 'close'] },
        url: { type: 'string' },
        ref: { type: 'integer', description: 'Element number from the latest snapshot' },
        selector: { type: 'string', description: 'CSS selector, as an alternative to ref' },
        text: { type: 'string', description: 'Text to type, link/button text to click, or text to wait for' },
        key: { type: 'string' },
        clear: { type: 'boolean' },
        submit: { type: 'boolean' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'integer' },
        ms: { type: 'integer' },
        full_page: { type: 'boolean' },
        expression: { type: 'string' },
        index: { type: 'integer' }
      },
      required: ['action']
    }
  }
};

export function browserAvailable(env = process.env) {
  return Boolean(env.OASIS_CHROME_PORT || findChrome(env));
}

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
    local: localHttp || localBlank,
    approvalKey: opaqueTarget ? 'opaque-target:' + parsed.href : parsed.origin,
    approvalTarget: opaqueTarget ? parsed.href.slice(0, 1200) : parsed.origin
  };
}

export function browserNavigationNeedsApproval(rawUrl, approvedNavigations) {
  const policy = rawUrl && typeof rawUrl === 'object' && typeof rawUrl.approvalKey === 'string'
    ? rawUrl
    : browserNavigationPolicy(rawUrl);
  return !policy.local && !approvedNavigations.has(policy.approvalKey);
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 }, Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' }
};

// Runs in the page: numbers visible interactive elements and returns text plus the list.
const SNAPSHOT_JS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  document.querySelectorAll('[data-oasis-ref]').forEach((el) => el.removeAttribute('data-oasis-ref'));
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [contenteditable=true], [onclick]';
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || n >= 300) continue;
    n += 1;
    el.setAttribute('data-oasis-ref', String(n));
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const item = { ref: n, tag: el.tagName.toLowerCase(), name };
    const role = el.getAttribute('role'); if (role) item.role = role;
    if (el.type && el.tagName !== 'BUTTON') item.type = el.type;
    if (el.href) item.href = el.href.slice(0, 200);
    if ('value' in el && el.value && el.tagName !== 'BUTTON') item.value = String(el.value).slice(0, 80);
    if (el.checked) item.checked = true;
    if (el.disabled) item.disabled = true;
    items.push(item);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 12000);
  return { url: location.href, title: document.title, text, elements: items, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight } };
})()`;

function locatorJs(args) {
  if (Number.isInteger(args.ref)) return 'document.querySelector(' + JSON.stringify('[data-oasis-ref="' + args.ref + '"]') + ')';
  if (args.selector) return 'document.querySelector(' + JSON.stringify(String(args.selector)) + ')';
  if (args.text) return '(() => { const want = ' + JSON.stringify(String(args.text).trim().toLowerCase()) + '; const all = [...document.querySelectorAll("a, button, [role=button], [role=link], input[type=submit], input[type=button], summary, label")]; return all.find((el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase() === want) || all.find((el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase().includes(want)) || null; })()';
  return null;
}

async function evaluate(page, expression, { awaitPromise = true } = {}) {
  const out = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (out.exceptionDetails) throw new Error('Page error: ' + ((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text || 'exception').split('\n')[0]);
  return out.result ? out.result.value : undefined;
}

async function setupPage(state, page, context) {
  const tab = { page, console: [], network: new Map(), blockedNavigations: [] };
  page.on('Runtime.consoleAPICalled', (p) => { tab.console.push({ type: p.type, text: (p.args || []).map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(' ').slice(0, 1000) }); if (tab.console.length > 200) tab.console.shift(); });
  page.on('Runtime.exceptionThrown', (p) => { const d = p.exceptionDetails || {}; tab.console.push({ type: 'exception', text: ((d.exception && d.exception.description) || d.text || 'Uncaught exception').slice(0, 1500) }); });
  page.on('Log.entryAdded', (p) => { const e = p.entry || {}; if (e.level === 'error' || e.level === 'warning') tab.console.push({ type: e.level, text: String(e.text || '').slice(0, 1000) + (e.url ? ' (' + e.url + ')' : '') }); });
  page.on('Network.requestWillBeSent', (p) => { tab.network.set(p.requestId, { method: p.request.method, url: p.request.url.slice(0, 300), type: p.type }); if (tab.network.size > 300) tab.network.delete(tab.network.keys().next().value); });
  page.on('Network.responseReceived', (p) => { const r = tab.network.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType; } });
  page.on('Network.loadingFailed', (p) => { const r = tab.network.get(p.requestId); if (r) r.failed = p.errorText || 'failed'; });
  await Promise.all([page.send('Page.enable'), page.send('Runtime.enable'), page.send('Network.enable'), page.send('Log.enable').catch(() => {})]);
  const frameTree = await page.send('Page.getFrameTree');
  tab.mainFrameId = frameTree && frameTree.frameTree && frameTree.frameTree.frame && frameTree.frameTree.frame.id;
  page.on('Page.frameNavigated', (frame) => {
    if (frame && !frame.parentId) tab.mainFrameId = frame.id;
  });
  // Gate top-level document navigations from links, forms, redirects and page
  // scripts too—not only explicit browser.navigate tool calls.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  page.on('Fetch.requestPaused', (request) => {
    void (async () => {
      const resume = () => page.send('Fetch.continueRequest', { requestId: request.requestId }).catch(() => {});
      const fail = () => page.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      if (request.resourceType !== 'Document') { await resume(); return; }
      if (!tab.mainFrameId) {
        tab.blockedNavigations.push({ url: String(request.request.url || '').slice(0, 1200), reason: 'The browser main frame could not be identified safely.' });
        await fail();
        return;
      }
      if (request.frameId !== tab.mainFrameId) { await resume(); return; }
      let policy;
      try { policy = browserNavigationPolicy(request.request.url); }
      catch (error) {
        tab.blockedNavigations.push({ url: String(request.request.url || '').slice(0, 1200), reason: error.message });
        await fail();
        return;
      }
      if (browserNavigationNeedsApproval(policy, state.approvedNavigations)) {
        const approved = await approve(context,
          'Follow top-level navigation to ' + policy.approvalTarget + '?\n  ' + policy.url,
          { tool: 'browser', input: { action: 'navigate', url: policy.url, source: 'page-navigation' } });
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
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  return tab;
}

async function ensureBrowser(session, env) {
  if (session.browserState && session.browserState.tabs.length && !session.browserState.tabs[session.browserState.active].page.closed) return session.browserState;
  if (session.browserState) await closeBrowser(session);
  const port = Number(env.OASIS_CHROME_PORT || 0);
  const headless = env.OASIS_CHROME_HEADLESS ? env.OASIS_CHROME_HEADLESS !== '0' : !(process.platform === 'darwin' || process.platform === 'win32' || env.DISPLAY || env.WAYLAND_DISPLAY);
  const browser = port ? await Browser.attach(port) : await Browser.launch({ env, headless });
  const state = { browser, tabs: [], active: 0, approvedNavigations: new Set(), evalApproved: false, attached: Boolean(port) };
  session.browserState = state;
  let target = null;
  if (!port) target = (await browser.pages())[0] || null;
  const page = target ? await browser.connect(target) : await browser.newPage('about:blank');
  state.tabs.push(await setupPage(state, page, context));
  return state;
}

export async function closeBrowser(session) {
  const state = session && session.browserState;
  if (!state) return;
  session.browserState = null;
  for (const tab of state.tabs) { try { tab.page.close(); } catch {} }
  if (!state.attached) await state.browser.close().catch(() => {});
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
    try { ready = await evaluate(page, 'document.readyState', { awaitPromise: false }); } catch {}
    if (ready === 'complete' || ready === 'interactive' && Date.now() - started > 3000) return;
    if (Date.now() - started > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function center(page, args) {
  const locator = locatorJs(args);
  if (!locator) throw new Error('Give ref (from snapshot), selector or text.');
  const box = await evaluate(page, '(() => { const el = ' + locator + '; if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), name: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 60) }; })()');
  if (!box) throw new Error('No element matched' + (Number.isInteger(args.ref) ? ' ref ' + args.ref + '; take a new snapshot' : '') + '.');
  return box;
}

async function pressKey(page, name) {
  const info = KEYS[name] || (name.length === 1 ? { code: 'Key' + name.toUpperCase(), keyCode: name.toUpperCase().charCodeAt(0), text: name } : null);
  if (!info) throw new Error('Unknown key ' + name + '. Use one of ' + Object.keys(KEYS).join(', ') + ' or a single character.');
  const key = info.key || name;
  await page.send('Input.dispatchKeyEvent', { type: info.text ? 'keyDown' : 'rawKeyDown', key, code: info.code, windowsVirtualKeyCode: info.keyCode, text: info.text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: info.code, windowsVirtualKeyCode: info.keyCode });
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

export async function executeBrowserTool(args, context = {}) {
  const session = context.session || context;
  const env = context.env || process.env;
  const action = String(args.action || '');
  if (action === 'close') { await closeBrowser(session); return { closed: true }; }
  const state = await ensureBrowser(session, env);
  let tab = state.tabs[state.active];
  const page = tab.page;
  switch (action) {
    case 'navigate': {
      const policy = browserNavigationPolicy(args.url);
      const url = policy.url;
      if (browserNavigationNeedsApproval(policy, state.approvedNavigations)) {
        if (!(await approve(context, 'Open ' + policy.approvalTarget + ' in the browser?\n  ' + url, { tool: 'browser', input: args }))) {
          return { error: 'The user did not approve opening ' + policy.approvalTarget + '.' };
        }
      }
      state.approvedNavigations.add(policy.approvalKey);
      const loaded = page.once('Page.loadEventFired', 20000);
      const nav = await page.send('Page.navigate', { url });
      if (nav.errorText) return { error: 'Navigation failed: ' + nav.errorText, url, blockedNavigations: tab.blockedNavigations.splice(0) };
      await Promise.race([loaded, settle(20000)]);
      await waitForLoad(page);
      const blockedNavigations = tab.blockedNavigations.splice(0);
      return { url: await evaluate(page, 'location.href'), title: await evaluate(page, 'document.title'), ...(blockedNavigations.length ? { blockedNavigations } : {}), hint: 'Take a snapshot to read the page and get element refs.' };
    }
    case 'snapshot': {
      const snap = await evaluate(page, SNAPSHOT_JS);
      return snap;
    }
    case 'click': {
      const box = await center(page, args);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      await settle(400);
      await waitForLoad(page, 5000);
      const blockedNavigations = tab.blockedNavigations.splice(0);
      return { clicked: box.tag + (box.name ? ' "' + box.name + '"' : ''), url: await evaluate(page, 'location.href'), ...(blockedNavigations.length ? { blockedNavigations } : {}) };
    }
    case 'type': {
      const locator = locatorJs(args);
      if (locator) {
        const ok = await evaluate(page, '(() => { const el = ' + locator + '; if (!el) return false; el.scrollIntoView({ block: "center" }); el.focus(); ' + (args.clear ? 'if ("value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } else if (el.isContentEditable) el.textContent = "";' : '') + ' return true; })()');
        if (!ok) throw new Error('No element matched' + (Number.isInteger(args.ref) ? ' ref ' + args.ref + '; take a new snapshot' : '') + '.');
      }
      await page.send('Input.insertText', { text: String(args.text || '') });
      if (args.submit) { await pressKey(page, 'Enter'); await settle(500); await waitForLoad(page, 8000); }
      const blockedNavigations = tab.blockedNavigations.splice(0);
      return { typed: String(args.text || '').length + ' characters', submitted: Boolean(args.submit), ...(blockedNavigations.length ? { blockedNavigations } : {}) };
    }
    case 'press': {
      await pressKey(page, String(args.key || 'Enter'));
      await settle(250);
      const blockedNavigations = tab.blockedNavigations.splice(0);
      return { pressed: args.key || 'Enter', ...(blockedNavigations.length ? { blockedNavigations } : {}) };
    }
    case 'scroll': {
      const amount = Math.max(1, Math.min(20000, Number(args.amount) || 700));
      const y = await evaluate(page, 'window.scrollBy(0, ' + (args.direction === 'up' ? -amount : amount) + '); Math.round(scrollY)');
      return { scrollY: y };
    }
    case 'wait': {
      if (args.text) {
        const want = JSON.stringify(String(args.text));
        const limit = Math.min(30000, Number(args.ms) || 10000);
        const started = Date.now();
        while (Date.now() - started < limit) {
          if (await evaluate(page, 'document.body && document.body.innerText.includes(' + want + ')')) return { found: true, after_ms: Date.now() - started };
          await settle(200);
        }
        return { found: false, waited_ms: limit };
      }
      const ms = Math.min(30000, Math.max(0, Number(args.ms) || 1000));
      await settle(ms);
      return { waited_ms: ms };
    }
    case 'screenshot': {
      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(args.full_page), ...(args.full_page ? { clip: await evaluate(page, '({ x: 0, y: 0, width: document.documentElement.scrollWidth, height: Math.min(document.documentElement.scrollHeight, 8000), scale: 1 })') } : {}) });
      const result = { screenshot: 'attached', url: await evaluate(page, 'location.href'), bytes: Math.round(shot.data.length * 0.75) };
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
      const text = value === undefined ? 'undefined' : JSON.stringify(value);
      return { value: text && text.length > 20000 ? text.slice(0, 20000) + '… (truncated)' : text };
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
        let title = '', url = '';
        try { url = await evaluate(t.page, 'location.href'); title = await evaluate(t.page, 'document.title'); } catch {}
        list.push({ index: i, active: i === state.active, url, title });
      }
      return { tabs: list };
    }
    case 'new_tab': {
      const created = await state.browser.newPage('about:blank');
      state.tabs.push(await setupPage(state, created, context));
      state.active = state.tabs.length - 1;
      if (args.url) return executeBrowserTool({ action: 'navigate', url: args.url }, context);
      return { index: state.active };
    }
    case 'switch_tab': {
      const index = Number(args.index);
      if (!state.tabs[index]) throw new Error('No tab ' + args.index + '.');
      state.active = index;
      await state.tabs[index].page.send('Page.bringToFront').catch(() => {});
      return { active: index };
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
