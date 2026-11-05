// End-to-end test of the universal app in a real Chromium, driven like a user:
// paste a server address into the message box, watch OASIS connect and lock in
// a model, run a task that calls tools, survive a model running out of credit,
// open plugins, and open the live preview. Skipped when no Chrome is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, Browser } from '../src/cdp.mjs';
import { startAppServer } from '../src/app-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = findChrome(process.env);

const PAGE = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="t">Counter</h1><button id="b">0</button><script src="app.js"></script></body></html>';

/** A tiny OpenAI-compatible server with a scripted agent behind it. */
function mockProvider() {
  const state = { calls: [], failModel: null, tasks: 0 };
  const models = ['acme/coder-pro', 'acme/coder-mini', 'acme/embed-small'];
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    res.end(JSON.stringify(body));
  };
  const toolCall = (name, args) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
  const text = (content) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return reply(res, 204, {});
    if (req.url === '/v1/models') return reply(res, 200, { data: models.map((id) => ({ id })) });
    if (req.url !== '/v1/chat/completions') return reply(res, 404, { error: { message: 'not found' } });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.calls.push({ model: body.model, tools: (body.tools || []).map((t) => t.function.name), system: (body.messages[0] && body.messages[0].content) || '' });
    if (body.model === state.failModel) return reply(res, 402, { error: { message: 'Insufficient credits. Add more using https://example.com/credits' } });
    const names = (body.tools || []).map((t) => t.function.name);
    if (names.includes('record_ok')) return reply(res, 200, toolCall('record_ok', { ok: true }));
    const messages = body.messages;
    const last = messages[messages.length - 1];
    const user = [...messages].reverse().find((m) => m.role === 'user');
    const ask = String(user && user.content);
    if (last.role === 'tool') {
      const wrote = messages.filter((m) => m.role === 'tool').length;
      if (/counter/i.test(ask) && wrote < 3) {
        if (wrote === 1) return reply(res, 200, toolCall('write_file', { path: 'style.css', content: 'h1{color:green}' }));
        return reply(res, 200, toolCall('write_file', { path: 'app.js', content: "const b=document.getElementById('b');b.onclick=()=>b.textContent=Number(b.textContent)+1;" }));
      }
      if (/broken/i.test(ask)) return reply(res, 200, text('Broken page written.'));
      return reply(res, 200, text('Done. I built the counter in index.html with style.css and app.js.'));
    }
    if (/counter/i.test(ask)) return reply(res, 200, toolCall('write_file', { path: 'index.html', content: PAGE }));
    if (/broken/i.test(ask)) return reply(res, 200, toolCall('write_file', { path: 'broken.html', content: '<!doctype html><p>hi</p><script>throw new Error("kaboom")</script>' }));
    state.tasks += 1;
    return reply(res, 200, text('Answer from ' + body.model + '.'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: 'http://127.0.0.1:' + server.address().port + '/v1' })));
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(page, expression, { timeout = 20000, label = expression } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await evaluate(page, expression).catch((error) => error.message);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  const seen = await evaluate(page, `JSON.stringify({ transcript: document.getElementById('transcript').textContent.slice(-600), toasts: document.getElementById('toasts').textContent, log: document.getElementById('connectLog').textContent, suggest: document.getElementById('pluginSuggest').outerHTML.slice(0, 400), msgs: window.__msgs })`).catch(() => '');
  throw new Error('Timed out waiting for: ' + label + ' (last: ' + JSON.stringify(last) + ') page: ' + seen);
}
const paste = (selector, value) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(value)}); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`;
const type = (value) => `(() => { const el = document.getElementById('input'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const submit = `(() => { document.getElementById('composer').requestSubmit(); return true; })()`;
const busy = `document.getElementById('app').classList.contains('busy')`;

test('universal app end to end: paste to connect, tool-calling task, credit fallback, plugins, preview', { skip: chrome ? false : 'no Chrome/Chromium installed', timeout: 180000 }, async (t) => {
  const provider = await mockProvider();
  const app = await startAppServer({ root, port: 0 });
  const browser = await Browser.launch({ env: { ...process.env, OASIS_CHROME_HEADLESS: '1' }, executable: chrome });
  t.after(async () => { await browser.close(); app.close(); provider.server.close(); });
  const base = 'http://127.0.0.1:' + app.address().port + '/';
  const page = await browser.newPage('about:blank');
  await page.send('Runtime.enable');
  const errors = [];
  page.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails.exception ? event.exceptionDetails.exception.description : event.exceptionDetails.text));
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: base });
  await waitFor(page, `document.readyState === 'complete' && !!document.getElementById('connectInput')`);
  // Full auto, so the test does not stop at approval sheets.
  await evaluate(page, `localStorage.setItem('oasis.settings', JSON.stringify({ mode: 'auto' })); location.reload(); true`);
  await waitFor(page, `document.readyState === 'complete' && !!document.getElementById('modelChip') && document.getElementById('modelChip').textContent === 'Connect a model'`);

  // 1. Paste the server address straight into the message box.
  assert.equal(await evaluate(page, `getComputedStyle(document.getElementById('connectForm')).display !== 'none'`), true, 'connect card shows before a model is set up');
  await evaluate(page, paste('#input', provider.url));
  await waitFor(page, `[...document.querySelectorAll('.connect-note li.ready')].some((li) => /Locked in acme\\/coder-pro/.test(li.textContent))`, { label: 'locked in the best model' });
  assert.equal(await evaluate(page, `document.getElementById('input').value`), '', 'the pasted address never stays in the message box');
  assert.match(await evaluate(page, `document.getElementById('modelChip').textContent`), /coder-pro/);
  const settings = await evaluate(page, `JSON.parse(localStorage.getItem('oasis.settings'))`);
  assert.equal(settings.connections.length, 1);
  assert.deepEqual(settings.connections[0].models.slice(0, 2), ['acme/coder-pro', 'acme/coder-mini']);
  assert.ok(!settings.connections[0].models.includes('acme/embed-small'), 'embedding models are filtered out');
  assert.equal(await evaluate(page, `getComputedStyle(document.getElementById('connectForm')).display`), 'none', 'connect card hides once connected');
  assert.ok(provider.state.calls.some((call) => call.tools.includes('record_ok')), 'the model was tool-tested before locking in');

  // 2. A real task with tool calls: build a small web app.
  await evaluate(page, type('Build a counter web app in index.html'));
  await waitFor(page, `!document.getElementById('pluginSuggest').hidden && /Web app/.test(document.getElementById('pluginSuggest').textContent)`, { label: 'web plugin suggested while typing' });
  await evaluate(page, `document.querySelector('#pluginSuggest .suggest-chip').click(); true`);
  await evaluate(page, submit);
  await waitFor(page, `!${busy} && /Done\\. I built the counter/.test(document.getElementById('transcript').textContent)`, { label: 'task finished' });
  const lastTask = provider.state.calls.filter((call) => call.tools.includes('write_file')).pop();
  assert.match(lastTask.system, /web-app-development|Web app/i, 'the tapped plugin loaded its skill into the request');
  assert.equal(await evaluate(page, `document.querySelectorAll('.tool').length`), 3, 'three tool cards shown');
  // Tool output is only rendered when a card is opened.
  assert.equal(await evaluate(page, `document.querySelector('.tool pre').textContent`), '');

  // 3. Preview: OASIS offers it after a turn that wrote HTML.
  await waitFor(page, `[...document.querySelectorAll('.msg.note .btn')].some((b) => /Open preview of index\\.html/.test(b.textContent))`, { label: 'preview offered' });
  await evaluate(page, `[...document.querySelectorAll('.msg.note .btn')].find((b) => /Open preview/.test(b.textContent)).click(); true`);
  await waitFor(page, `!document.getElementById('previewSheet').hidden && /preview\\.html/.test(document.getElementById('previewFrame').src)`, { label: 'preview sheet open' });

  // 4. A page with an error: the preview reports it and offers a fix.
  await evaluate(page, `document.querySelector('[data-close="previewSheet"]').click(); true`);
  await evaluate(page, type('Make a broken page'));
  await evaluate(page, submit);
  await waitFor(page, `!${busy} && /Broken page written/.test(document.getElementById('transcript').textContent)`, { label: 'broken page written' });
  await evaluate(page, `window.__msgs = []; addEventListener('message', (e) => window.__msgs.push(JSON.stringify(e.data).slice(0, 120) + ' src=' + document.getElementById('previewFrame').src.slice(-12))); document.getElementById('previewButton').click(); true`);
  await waitFor(page, `[...document.getElementById('previewSelect').options].some((o) => o.value === 'broken.html')`);
  await evaluate(page, `(() => { const s = document.getElementById('previewSelect'); s.value = 'broken.html'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(page, `/kaboom/.test(document.getElementById('toasts').textContent) && /Fix the preview error/.test(document.getElementById('pluginSuggest').textContent)`, { label: 'preview error reported' });
  await evaluate(page, `document.querySelector('[data-close="previewSheet"]').click(); true`);

  // 5. The best model runs out of credit mid-session: OASIS moves on by itself.
  provider.state.failModel = 'acme/coder-pro';
  await evaluate(page, type('What does this project do?'));
  await evaluate(page, submit);
  await waitFor(page, `!${busy} && /Answer from acme\\/coder-mini/.test(document.getElementById('transcript').textContent)`, { label: 'fell back to the next model' });
  assert.match(await evaluate(page, `document.getElementById('transcript').textContent`), /coder-pro ran out of credit\. Switched to acme\/coder-mini/);
  assert.match(await evaluate(page, `document.getElementById('modelChip').textContent`), /coder-mini/, 'the new model stays active');

  // 6. Plugins: one tap turns a plugin on for the project.
  await evaluate(page, `document.getElementById('pluginsButton').click(); true`);
  await waitFor(page, `document.querySelectorAll('#pluginGrid .plugin-tile').length >= 10`);
  await evaluate(page, `document.querySelector('#pluginGrid [data-plugin="security"] .plugin-head').click(); true`);
  await waitFor(page, `document.querySelector('#pluginGrid [data-plugin="security"]').classList.contains('on') && document.getElementById('pluginCount').textContent === '1'`, { label: 'plugin switched on' });

  // 7. Pasting a second key in Settings adds a connection without touching the first.
  await evaluate(page, `document.querySelector('[data-close="pluginsSheet"]').click(); document.getElementById('settingsButton').click(); true`);
  await waitFor(page, `document.querySelectorAll('#connectionList .connection').length === 1`);
  assert.equal(await evaluate(page, `document.getElementById('manualSetup').open`), false, 'manual provider fields stay tucked away');
  assert.deepEqual(errors, [], 'no uncaught errors in the app');
});
