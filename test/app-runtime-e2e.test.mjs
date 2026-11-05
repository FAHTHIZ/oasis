// End-to-end test of the universal app driving the agent on this computer:
// `oasis web` serves the same app at /, the browser pastes a model address,
// the runtime detects the provider and saves it, and a task edits a real file
// after the user approves it in the app's own approval sheet. Skipped when no
// Chrome is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { findChrome, Browser } from '../src/cdp.mjs';
import { startOasisWebServer } from '../src/web.mjs';

const chrome = findChrome(process.env);
process.env.OASIS_REQUIRE_READ_BEFORE_EDIT = '0';

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
    // The runtime's post-edit verification gate: answer it like a real model.
    if (last.role === 'user' && /verification gate/.test(String(last.content))) return reply(res, 200, text('Done. I built the counter in index.html with style.css and app.js, and checked it with node.'));
    if (messages.some((m) => m.role === 'user' && /slow check/i.test(String(m.content)))) {
      if (last.role === 'tool') {
        const note = messages.slice(1).find((m) => m.role === 'user' && /tabs/.test(String(m.content)));
        return reply(res, 200, text(note ? 'Checked, and noted: use tabs.' : 'Checked.'));
      }
      if (last.role === 'user' && /tabs/.test(String(last.content))) return reply(res, 200, text('Checked, and noted: use tabs.'));
      return reply(res, 200, toolCall('run_command', { command: 'node', args: ['-e', 'console.log(1)'] }));
    }
    if (last.role === 'tool') {
      const wrote = messages.filter((m) => m.role === 'tool').length;
      if (/counter/i.test(ask) && wrote < 3) {
        if (wrote === 1) return reply(res, 200, toolCall('write_file', { path: 'style.css', content: 'h1{color:green}' }));
        return reply(res, 200, toolCall('write_file', { path: 'app.js', content: "const b=document.getElementById('b');b.onclick=()=>b.textContent=Number(b.textContent)+1;" }));
      }
      if (/counter/i.test(ask) && wrote === 3) return reply(res, 200, toolCall('run_command', { command: 'node', args: ['-e', 'console.log(40 + 2)'] }));
      return reply(res, 200, text('Done. I built the counter in index.html with style.css and app.js.'));
    }
    if (/counter/i.test(ask)) return reply(res, 200, toolCall('write_file', { path: 'index.html', content: PAGE }));
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

test('runtime engine end to end: app at /, paste to connect, approve a real edit, files and changes', { skip: chrome ? false : 'no Chrome/Chromium installed', timeout: 180000 }, async (t) => {
  const provider = await mockProvider();
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-runtime-app-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-runtime-config-'));
  await writeFile(path.join(root, 'README.md'), '# Demo\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  let git = true;
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
  } catch { git = false; }
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '' };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789abcdef' });
  const browser = await Browser.launch({ env: { ...process.env, OASIS_CHROME_HEADLESS: '1' }, executable: chrome });
  t.after(async () => { await browser.close(); await app.close(); provider.server.close(); await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + app.port;
  const page = await browser.newPage('about:blank');
  await page.send('Runtime.enable');
  const errors = [];
  page.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails.exception ? event.exceptionDetails.exception.description : event.exceptionDetails.text));
  await page.send('Page.enable');
  // OASIS_SHOTS_DIR=/tmp/x saves screenshots of each step for design review.
  const shotsDir = process.env.OASIS_SHOTS_DIR;
  const shot = async (name) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(shotsDir, 'runtime-' + name + '.png'), Buffer.from(data, 'base64'));
  };
  if (shotsDir) await page.send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.OASIS_SHOTS_WIDTH || 1280), height: Number(process.env.OASIS_SHOTS_HEIGHT || 800), deviceScaleFactor: 1, mobile: process.env.OASIS_SHOTS_MOBILE === '0' ? false : Number(process.env.OASIS_SHOTS_WIDTH || 1280) < 600 });

  // 1. Without the link's token the app asks for it, and the paste box takes the link.
  await page.send('Page.navigate', { url: origin + '/' });
  await waitFor(page, `document.readyState === 'complete' && location.pathname === '/app/' && document.getElementById('welcomeTitle').textContent === 'Paste your OASIS link.'`, { label: 'asks for the runtime link' });
  await shot('1-link');
  await evaluate(page, `document.getElementById('connectInput').value = ${JSON.stringify(origin + '/app/#token=' + app.token)}; document.getElementById('connectForm').requestSubmit(); true`);
  await waitFor(page, `document.readyState === 'complete' && document.documentElement.classList.contains('runtime') && document.getElementById('welcomeTitle').textContent === 'Paste a key to start.' && !/^(No project|This computer)$/.test(document.getElementById('projectName').textContent)`, { label: 'connected to the runtime after pasting the link' });
  assert.equal(await evaluate(page, `location.hash`), '', 'the token never stays in the address bar');
  assert.match(await evaluate(page, `document.getElementById('projectName').textContent`), new RegExp(path.basename(root)));

  await shot('2-key');
  // 2. Paste the model server address: the runtime finds the best model and saves it.
  await evaluate(page, paste('#input', provider.url));
  await waitFor(page, `[...document.querySelectorAll('.connect-note li.ready')].some((li) => /Locked in acme\\/coder-pro/.test(li.textContent))`, { label: 'runtime locked in the best model' });
  assert.match(await evaluate(page, `document.getElementById('modelChip').textContent`), /coder-pro/);
  const saved = JSON.parse(await readFile(path.join(configDir, 'config.json'), 'utf8'));
  assert.equal(saved.model, 'acme/coder-pro');
  assert.equal(saved.fallbackModel, 'acme/coder-mini', 'the next-best model is the backup');
  assert.equal(await evaluate(page, `localStorage.getItem('oasis.settings') || ''`).then((raw) => /coder-pro/.test(raw)), false, 'the browser keeps no copy of the connection');

  // 3. A task that edits real files (checkpointed, no prompt) and then runs a
  // command, which the app's own approval sheet asks about.
  await evaluate(page, type('Build a counter web app in index.html'));
  await evaluate(page, submit);
  await waitFor(page, `!document.getElementById('approvalSheet').hidden`, { label: 'approval sheet for the command', timeout: 30000 });
  assert.match(await evaluate(page, `document.querySelector('#approvalSummary .approval-command').textContent`), /^node -e/);
  assert.equal(await evaluate(page, `document.querySelector('#approvalSummary .risk-badge') ? 'risky' : 'plain'`), 'risky');
  await shot('3-approval');
  await evaluate(page, `document.getElementById('allowButton').click(); true`);
  await waitFor(page, `!${busy} && /Done\\. I built the counter/.test(document.getElementById('transcript').textContent)`, { label: 'runtime task finished', timeout: 40000 });
  assert.match(await readFile(path.join(root, 'index.html'), 'utf8'), /Counter/, 'the file was written on disk');
  assert.equal(await evaluate(page, `document.querySelectorAll('.tool').length`), 4, 'one card per tool call');
  assert.equal(await evaluate(page, `[...document.querySelectorAll('.tool')].at(-1).className`), 'tool ok', 'the approved command ran');
  assert.match(await evaluate(page, `[...document.querySelectorAll('.tool')].at(-1).textContent`), /Run.*node -e/);

  await shot('4-done');
  if (process.env.OASIS_DEBUG_OVERFLOW) console.log('OVERFLOW', await evaluate(page, `JSON.stringify({ sw: document.documentElement.scrollWidth, iw: innerWidth, wide: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && el.getClientRects().length).slice(0, 12).map((el) => el.tagName + '#' + el.id + '.' + el.className + ':' + Math.round(el.getBoundingClientRect().right)) })`));
  // 4. Files panel lists the real folder (no secrets); Changes comes from git.
  await evaluate(page, `document.getElementById('filesPanel').hidden && document.getElementById('filesButton').click(); true`);
  await waitFor(page, `[...document.querySelectorAll('#fileList .file-row')].some((row) => row.textContent.includes('index.html'))`, { label: 'files panel lists index.html' });
  assert.equal(await evaluate(page, `[...document.querySelectorAll('#fileList .file-row')].some((row) => row.textContent.includes('.env'))`), false, 'secret files are hidden');
  assert.equal(await evaluate(page, `document.getElementById('exportButton').hidden && document.getElementById('newFileButton').hidden`), true, 'device-only actions are hidden');
  if (git) await waitFor(page, `document.getElementById('changesCount').textContent === '3'`, { label: 'three changed files counted from git (OASIS internals excluded)' });
  assert.equal(await evaluate(page, `[...document.querySelectorAll('#fileList .file-row')].some((row) => row.textContent.includes('.oasis'))`), false, 'OASIS internals are not listed');
  await evaluate(page, `[...document.querySelectorAll('#fileList .file-row')].find((row) => row.textContent.includes('README.md')).click(); true`);
  await waitFor(page, `!document.getElementById('editorSheet').hidden && document.getElementById('editor').value.includes('# Demo') && document.getElementById('editor').readOnly`, { label: 'read-only viewer' });

  await shot('5-files');
  // 5. The session continues on reload.
  await evaluate(page, `location.reload(); true`);
  await waitFor(page, `document.readyState === 'complete' && document.documentElement.classList.contains('runtime') && /Done\\. I built the counter/.test(document.getElementById('transcript').textContent)`, { label: 'chat restored after reload' });

  // 6. Typing while OASIS works adds a note to the running task.
  await evaluate(page, type('Run a slow check'));
  await evaluate(page, submit);
  await waitFor(page, `!document.getElementById('approvalSheet').hidden`, { label: 'approval for the slow check', timeout: 30000 });
  await evaluate(page, type('use tabs please'));
  assert.equal(await evaluate(page, `document.body.classList.contains('steering') && document.getElementById('sendButton').getAttribute('aria-label')`), 'Send to the running task');
  await evaluate(page, submit);
  await waitFor(page, `document.getElementById('input').value === '' && [...document.querySelectorAll('.msg.user')].some((m) => /use tabs please/.test(m.textContent))`, { label: 'note shown in the chat' });
  await evaluate(page, `document.getElementById('allowButton').click(); true`);
  await waitFor(page, `!${busy} && /noted: use tabs/.test(document.getElementById('transcript').textContent)`, { label: 'the running task read the note', timeout: 30000 });

  // 7. New chat starts fresh; the earlier chat is one tap away in Chats.
  await evaluate(page, `document.getElementById('chatsButton').click(); true`);
  await waitFor(page, `!document.getElementById('chatsSheet').hidden && document.querySelectorAll('#chatList .project-item').length === 1 && /Build a counter/.test(document.getElementById('chatList').textContent)`, { label: 'chats list shows the current chat' });
  await evaluate(page, `document.getElementById('newChatButton').click(); true`);
  await waitFor(page, `document.getElementById('chatsSheet').hidden && !document.querySelector('#transcript .msg') && !document.getElementById('welcome').hidden`, { label: 'new chat is empty' });
  await evaluate(page, type('Say hi'));
  await evaluate(page, submit);
  await waitFor(page, `!${busy} && /Answer from acme\\/coder-pro/.test(document.getElementById('transcript').textContent)`, { label: 'second chat answered' });
  await evaluate(page, `document.getElementById('chatsButton').click(); true`);
  await waitFor(page, `document.querySelectorAll('#chatList .project-item').length === 2`, { label: 'two chats listed' });
  await shot('7-chats');
  await evaluate(page, `[...document.querySelectorAll('#chatList .project-item .open')].find((b) => /Build a counter/.test(b.textContent)).click(); true`);
  await waitFor(page, `/Done\\. I built the counter/.test(document.getElementById('transcript').textContent) && !/Say hi/.test(document.getElementById('transcript').textContent)`, { label: 'earlier chat reopened' });
  await evaluate(page, `location.reload(); true`);
  await waitFor(page, `document.readyState === 'complete' && document.documentElement.classList.contains('runtime') && /Done\\. I built the counter/.test(document.getElementById('transcript').textContent)`, { label: 'the open chat is remembered across reloads' });

  // 8. The desktop menu's "Connect a phone…" opens the app's phone sheet.
  await evaluate(page, `window.oasisConnectPhone(); true`);
  await waitFor(page, `!document.getElementById('phoneSheet').hidden && /home network|Tailscale|reachable/.test(document.getElementById('phoneHint').textContent) && !document.getElementById('phoneError').textContent`, { label: 'phone sheet shows the network choices' });
  await shot('6-phone');
  assert.deepEqual(errors, [], 'no uncaught errors in the app');
});
