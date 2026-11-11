// The inline Connect card: shown in the conversation when the agent asks to
// connect an app (connect_service) or from Settings → Connectors. It follows
// the in-chat pattern of hosted assistants: brand mark, name, why it is
// needed, one Connect button. Connect opens the sign-in in a popup; the card
// follows the flow (sign-in page, GitHub one-time code, token box) and settles
// as Connected, Skipped or Failed while the task carries on.
//
// The flow itself runs in the runtime (src/connectors.mjs); this file only
// renders its view and posts the user's choices through `actions`:
//   actions.act({ action: 'connect' | 'skip' | 'token' | 'callback', token?, address? })
//   actions.status() → the flow's current view
import { BRAND_ICONS } from './brand-icons.mjs';

const SETTLED = new Set(['connected', 'failed', 'skipped']);
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Relative luminance of #RRGGBB (0 dark … 1 light). */
export function luminance(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The brand tile: the logo on its brand colour, or the first letter. */
export function brandMark(connector = {}) {
  const icon = BRAND_ICONS[connector.id];
  const tile = el('span', 'cc-mark');
  tile.setAttribute('aria-hidden', 'true');
  const hex = icon ? icon.hex : '';
  if (icon) {
    tile.style.background = hex;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', icon.path);
    path.setAttribute('fill', luminance(hex) > 0.45 ? '#0B100C' : '#FFFFFF');
    svg.appendChild(path);
    tile.appendChild(svg);
  } else {
    tile.classList.add('letter');
    tile.textContent = String(connector.name || connector.id || '?').trim().charAt(0).toUpperCase() || '?';
  }
  return tile;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * "/connect github" → { service: 'github', explicit: true }; "connect my Linear
 * account" → { service: 'Linear', explicit: false }; anything else → null.
 */
export function connectIntent(text) {
  const slash = /^\/connect(?:\s+(.+))?$/i.exec(text.trim());
  if (slash) return { service: (slash[1] || '').trim(), explicit: true };
  const plain = /^(?:please\s+)?(?:connect|link|hook\s+up|sign\s+in\s+to|log\s+in\s+to)\s+(?:to\s+|with\s+)?(?:my\s+|the\s+)?(.{2,40}?)(?:\s+(?:account|app|workspace|connector|mcp))?\s*[.!]?$/i.exec(text.trim());
  return plain ? { service: plain[1].trim(), explicit: false } : null;
}

const SOURCE_LABEL = { catalog: 'Verified', registry: 'MCP Registry', url: 'Custom' };

/**
 * Renders a card for `data` (a flow view) and drives it. Returns
 * { element, done } where done resolves with the final view.
 * options: { copy(text), toast(text), pollMs, autoConnect }
 */
export function createConnectorCard(data, actions, options = {}) {
  const { copy = (text) => navigator.clipboard && navigator.clipboard.writeText(text), toast = () => {}, pollMs = 1000 } = options;
  let view = { ...data, connector: { ...(data.connector || {}) } };
  const connector = view.connector;
  const card = el('section', 'connector-card');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Connect ' + (connector.name || 'an app'));

  const head = el('div', 'cc-head');
  head.appendChild(brandMark(connector));
  const titles = el('div', 'cc-titles');
  const title = el('div', 'cc-title');
  title.appendChild(el('strong', '', connector.name || 'App'));
  const badge = SOURCE_LABEL[connector.source || 'catalog'];
  if (badge) title.appendChild(el('span', 'cc-badge' + (connector.source === 'catalog' || !connector.source ? ' ok' : ''), badge));
  titles.appendChild(title);
  titles.appendChild(el('div', 'cc-sub', connector.description || hostOf(connector.url)));
  head.appendChild(titles);
  card.appendChild(head);

  const reason = el('p', 'cc-reason');
  card.appendChild(reason);
  const stage = el('div', 'cc-stage');
  card.appendChild(stage);
  const foot = el('div', 'cc-foot');
  const fine = el('span', 'cc-fine');
  const buttons = el('div', 'cc-buttons');
  const skipButton = el('button', 'btn ghost small', 'Not now');
  skipButton.type = 'button';
  const connectButton = el('button', 'btn primary small', 'Connect');
  connectButton.type = 'button';
  buttons.append(skipButton, connectButton);
  foot.append(fine, buttons);
  card.appendChild(foot);

  let popup = null;
  let openedUrl = '';
  let timer = 0;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  let finished = false;

  const post = async (body) => {
    try {
      const next = await actions.act(body);
      if (next && next.status) apply(next);
      return next;
    } catch (error) {
      toast(String(error && error.message || error).replace(/^Error:\s*/, ''));
      return null;
    }
  };

  function openSignIn(url) {
    if (!url) return;
    if (popup && !popup.closed) {
      try { popup.location.href = url; popup.focus(); openedUrl = url; return; } catch { /* cross-origin already */ }
    }
    if (openedUrl === url) return;
    openedUrl = url;
    popup = null;
    // In the desktop app this opens the system browser and returns null; in a
    // browser that blocked the popup, the card's "Open sign-in page" button works.
    popup = window.open(url, 'oasis-connect', 'popup,width=520,height=720');
  }

  function closePopup() {
    try { if (popup && !popup.closed) popup.close(); } catch { /* ignore */ }
    popup = null;
  }

  function linkButton(label, url) {
    const a = el('a', 'btn small', label);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function render() {
    const status = view.status;
    card.dataset.status = status;
    reason.textContent = view.reason ? view.reason : '';
    reason.hidden = !view.reason || SETTLED.has(status);
    stage.replaceChildren();
    const host = hostOf(connector.url);
    fine.textContent = connector.auth === 'none'
      ? 'No sign-in needed.'
      : connector.auth === 'github' ? 'Signs in with GitHub. OASIS never sees your password.' : 'You sign in on ' + (host || 'the service') + '. OASIS never sees your password.';
    connectButton.hidden = status !== 'ready';
    skipButton.hidden = SETTLED.has(status);
    skipButton.textContent = status === 'ready' ? 'Not now' : 'Cancel';
    fine.hidden = SETTLED.has(status);

    if (status === 'working') {
      stage.appendChild(el('div', 'cc-progress', view.message || 'Connecting…'));
    } else if (status === 'authorize') {
      stage.appendChild(el('div', 'cc-progress', 'Finish signing in to ' + connector.name + ' in the window that opened.'));
      const row = el('div', 'cc-row');
      if (view.url) row.appendChild(linkButton('Open sign-in page', view.url));
      stage.appendChild(row);
      if (view.canPasteCallback) {
        const details = el('details', 'cc-other');
        details.appendChild(el('summary', '', 'Signing in on another device?'));
        details.appendChild(el('p', 'cc-fine', 'After approving, the browser lands on a page starting with http://127.0.0.1 that may not load. Paste that address here.'));
        const form = el('form', 'cc-form');
        const input = el('input');
        input.type = 'url';
        input.placeholder = 'http://127.0.0.1:…/callback?code=…';
        input.setAttribute('aria-label', 'Address after sign-in');
        const send = el('button', 'btn small', 'Finish');
        send.type = 'submit';
        form.append(input, send);
        form.addEventListener('submit', (event) => { event.preventDefault(); if (input.value.trim()) post({ action: 'callback', address: input.value.trim() }); });
        details.appendChild(form);
        stage.appendChild(details);
      }
    } else if (status === 'device') {
      stage.appendChild(el('div', 'cc-progress', 'Enter this code on GitHub to finish.'));
      const code = el('div', 'cc-code');
      code.appendChild(el('span', 'cc-code-value', view.code));
      const copyButton = el('button', 'btn small', 'Copy');
      copyButton.type = 'button';
      copyButton.addEventListener('click', async () => { try { await copy(view.code); copyButton.textContent = 'Copied'; setTimeout(() => { copyButton.textContent = 'Copy'; }, 1500); } catch { toast('Copy failed. Select the code instead.'); } });
      code.appendChild(copyButton);
      stage.appendChild(code);
      const row = el('div', 'cc-row');
      if (view.url) {
        const open = el('button', 'btn small primary', 'Copy code and open GitHub');
        open.type = 'button';
        open.addEventListener('click', async () => { try { await copy(view.code); } catch { /* still open */ } openedUrl = ''; openSignIn(view.url); });
        row.appendChild(open);
      }
      stage.appendChild(row);
    } else if (status === 'token') {
      stage.appendChild(el('div', 'cc-progress', view.message || 'Paste a token to finish.'));
      const form = el('form', 'cc-form');
      const input = el('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.placeholder = 'ghp_… or github_pat_…';
      input.setAttribute('aria-label', 'Token');
      const save = el('button', 'btn small primary', 'Connect');
      save.type = 'submit';
      form.append(input, save);
      form.addEventListener('submit', (event) => { event.preventDefault(); if (input.value.trim()) { post({ action: 'token', token: input.value.trim() }); input.value = ''; } });
      stage.appendChild(form);
      if (view.url) {
        const row = el('div', 'cc-row');
        row.appendChild(linkButton('Create a token', view.url));
        stage.appendChild(row);
      }
      setTimeout(() => input.focus(), 0);
    } else if (status === 'connected') {
      const ok = el('div', 'cc-result ok');
      ok.appendChild(el('span', 'cc-check', '✓'));
      const count = (view.tools || []).length;
      ok.appendChild(el('span', '', 'Connected' + (view.account ? ' as ' + view.account : '') + (count ? ' · ' + count + ' tool' + (count === 1 ? '' : 's') + ' ready' : '')));
      stage.appendChild(ok);
    } else if (status === 'failed') {
      stage.appendChild(el('div', 'cc-result bad', view.message || 'Could not connect.'));
    } else if (status === 'skipped') {
      stage.appendChild(el('div', 'cc-result', 'Not connected. Ask again any time.'));
    }
  }

  function apply(next) {
    if (!next || finished) return;
    view = { ...view, ...next, connector: { ...view.connector, ...(next.connector || {}) } };
    if (view.status === 'authorize' && view.url) openSignIn(view.url);
    render();
    if (SETTLED.has(view.status)) {
      finished = true;
      clearTimeout(timer);
      closePopup();
      settle(view);
    }
  }

  async function poll() {
    if (finished) return;
    try { apply(await actions.status()); } catch { /* keep trying */ }
    if (!finished) timer = setTimeout(poll, pollMs);
  }

  connectButton.addEventListener('click', () => {
    // Open the popup in the click itself so it is not blocked; the sign-in
    // address arrives a moment later.
    if (connector.auth !== 'none' && connector.auth !== 'github') {
      try { popup = window.open('', 'oasis-connect', 'popup,width=520,height=720'); } catch { popup = null; }
      if (popup) { try { popup.document.title = 'Connecting ' + connector.name; popup.document.body.textContent = 'Opening ' + connector.name + ' sign-in…'; } catch { /* ignore */ } }
    }
    connectButton.disabled = true;
    apply({ status: 'working', message: 'Connecting…' });
    post({ action: 'connect' }).then(() => { connectButton.disabled = false; if (!finished) { clearTimeout(timer); timer = setTimeout(poll, 250); } });
  });
  skipButton.addEventListener('click', () => { closePopup(); post({ action: 'skip' }); });

  render();
  if (view.status !== 'ready' && !SETTLED.has(view.status)) timer = setTimeout(poll, 0);
  if (options.autoConnect && view.status === 'ready') connectButton.click();
  return { element: card, done, update: apply, stop() { finished = true; clearTimeout(timer); closePopup(); } };
}
