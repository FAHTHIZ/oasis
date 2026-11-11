import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.document = document;
globalThis.window = window;
window.open = () => null;
const { createConnectorCard, connectIntent, luminance } = await import('../app/core/connector-card.mjs');
const { BRAND_ICONS } = await import('../app/core/brand-icons.mjs');

const base = { id: '00000000-0000-4000-8000-000000000001', status: 'ready', reason: 'To read the failing issue.', connector: { id: 'linear', name: 'Linear', description: 'Issues, projects, cycles and documents.', url: 'https://mcp.linear.app/mcp', auth: 'oauth', source: 'catalog' } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('connect intent: /connect always, plain sentences only name an app', () => {
  assert.deepEqual(connectIntent('/connect github'), { service: 'github', explicit: true });
  assert.deepEqual(connectIntent('/connect'), { service: '', explicit: true });
  assert.deepEqual(connectIntent('Connect my Linear account.'), { service: 'Linear', explicit: false });
  assert.deepEqual(connectIntent('please connect to GitHub'), { service: 'GitHub', explicit: false });
  assert.deepEqual(connectIntent('sign in to notion'), { service: 'notion', explicit: false });
  assert.equal(connectIntent('fix the bug where connect fails in src/app.js and also update the docs for the new release'), null);
});

test('the card shows the brand, the reason and Connect / Not now', () => {
  const ui = createConnectorCard(base, { act: async () => base, status: async () => base });
  const card = ui.element;
  assert.equal(card.querySelector('.cc-title strong').textContent, 'Linear');
  assert.equal(card.querySelector('.cc-badge').textContent, 'Verified');
  assert.equal(card.querySelector('.cc-reason').textContent, 'To read the failing issue.');
  assert.ok(card.querySelector('.cc-mark svg path').getAttribute('d').startsWith(BRAND_ICONS.linear.path.slice(0, 10)));
  const buttons = [...card.querySelectorAll('.cc-buttons button')].map((b) => b.textContent);
  assert.deepEqual(buttons, ['Not now', 'Connect']);
  assert.match(card.querySelector('.cc-fine').textContent, /mcp\.linear\.app/);
  ui.stop();
});

test('Connect follows the flow to Connected and resolves done', async () => {
  const posted = [];
  const views = [
    { ...base, status: 'authorize', url: 'https://linear.app/oauth/authorize?x=1', canPasteCallback: true },
    { ...base, status: 'connected', tools: ['a', 'b', 'c'], account: '' }
  ];
  let opened = '';
  window.open = (url) => { if (url) opened = url; return null; };
  const ui = createConnectorCard(base, {
    act: async (body) => { posted.push(body); return { ...base, status: 'working' }; },
    status: async () => views.shift() || { ...base, status: 'connected', tools: ['a', 'b', 'c'] }
  }, { pollMs: 1 });
  ui.element.querySelector('.btn.primary').dispatchEvent(new window.Event('click'));
  const final = await ui.done;
  assert.deepEqual(posted, [{ action: 'connect' }]);
  assert.equal(final.status, 'connected');
  assert.equal(opened, 'https://linear.app/oauth/authorize?x=1');
  assert.match(ui.element.querySelector('.cc-result.ok').textContent, /Connected · 3 tools ready/);
  assert.equal(ui.element.dataset.status, 'connected');
});

test('GitHub device code and token box', async () => {
  const github = { ...base, connector: { ...base.connector, id: 'github', name: 'GitHub', auth: 'github' } };
  const ui = createConnectorCard({ ...github, status: 'device', code: 'AB12-CD34', url: 'https://github.com/login/device' }, { act: async () => null, status: async () => ({ ...github, status: 'device', code: 'AB12-CD34', url: 'https://github.com/login/device' }) }, { pollMs: 1000 });
  assert.equal(ui.element.querySelector('.cc-code-value').textContent, 'AB12-CD34');
  ui.update({ status: 'token', url: 'https://github.com/settings/tokens/new', message: 'Paste a GitHub token.' });
  const input = ui.element.querySelector('.cc-form input');
  assert.equal(input.getAttribute('type'), 'password');
  ui.stop();
});

test('Not now posts skip; failures show the reason', async () => {
  const posted = [];
  const ui = createConnectorCard(base, { act: async (body) => { posted.push(body); return { ...base, status: 'skipped' }; }, status: async () => base });
  ui.element.querySelector('.btn.ghost').dispatchEvent(new window.Event('click'));
  assert.equal((await ui.done).status, 'skipped');
  assert.deepEqual(posted, [{ action: 'skip' }]);
  const failed = createConnectorCard(base, { act: async () => null, status: async () => base });
  failed.update({ status: 'failed', message: 'access_denied' });
  await tick();
  assert.equal(failed.element.querySelector('.cc-result.bad').textContent, 'access_denied');
});

test('brand tiles keep the logo readable on light brand colours', () => {
  assert.ok(luminance('#FFD21E') > 0.45);
  assert.ok(luminance('#181717') < 0.1);
  assert.equal(Object.keys(BRAND_ICONS).length >= 13, true);
});
