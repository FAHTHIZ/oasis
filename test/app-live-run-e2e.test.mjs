// How a live run reads in the web app with a streaming model: narration
// between steps, the model's reasoning summary in a "Thinking" block that
// settles into "Thought for Ns" and survives a reload. Skipped without Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { findChrome, Browser } from '../src/cdp.mjs';
import { startOasisWebServer } from '../src/web.mjs';

const chrome = findChrome(process.env);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A streaming OpenAI-compatible model. Step 1 reasons (reasoning_content),
// narrates and reads a file; step 2 is slow and silent (no reasoning), then
// narrates and reads again; step 3 answers.
function streamingProvider(script) {
  const state = { requests: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'acme/streamer' }] })); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const tools = (body.messages || []).filter((m) => m.role === 'tool').length;
    state.requests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write('data: ' + JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] }) + '\n\n');
    const step = script[Math.min(tools, script.length - 1)];
    for (const part of step) {
      if (part.wait) await pause(part.wait);
      if (part.reasoning) send({ reasoning_content: part.reasoning });
      if (part.text) send({ content: part.text });
      if (part.tool) send({ tool_calls: [{ index: 0, id: 'call_' + state.requests, type: 'function', function: { name: part.tool, arguments: JSON.stringify(part.args || {}) } }] });
    }
    send({}, step.some((part) => part.tool) ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: 'http://127.0.0.1:' + server.address().port + '/v1' })));
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(page, expression, { timeout = 30000, label = expression } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await evaluate(page, expression).catch((error) => error.message);
    if (last) return last;
    await pause(50);
  }
  const seen = await evaluate(page, `document.getElementById('transcript').innerText.slice(-800)`).catch(() => '');
  throw new Error('Timed out waiting for: ' + label + ' (last: ' + JSON.stringify(last) + ') transcript: ' + seen);
}
const type = (value) => `(() => { const el = document.getElementById('input'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const submit = `(() => { document.getElementById('composer').requestSubmit(); return true; })()`;
const busy = `document.body.classList.contains('busy')`;

// Samples the page every 100 ms while a run is busy: is anything live on
// screen (a running step, the Thinking block, or text that grew in the last
// second)? The longest stretch with none of these is the silent gap.
export const SAMPLER = `(() => {
  const state = window.__live = { longestGap: 0, gapStart: 0, lastText: '', lastGrow: 0, samples: 0, firstNarration: 0, started: Date.now() };
  const tick = () => {
    const now = Date.now();
    const busy = document.body.classList.contains('busy');
    const text = [...document.querySelectorAll('#transcript .msg.assistant .body')].map((el) => el.textContent).join('|');
    if (text !== state.lastText) { state.lastText = text; state.lastGrow = now; if (!state.firstNarration && text.trim()) state.firstNarration = now - state.started; }
    const live = Boolean(document.querySelector('#transcript .thinking.live, #transcript .steps.running, #transcript .tool.running, #transcript .tool.waiting')) || now - state.lastGrow < 1000;
    if (busy && !live) { if (!state.gapStart) state.gapStart = now; state.longestGap = Math.max(state.longestGap, now - state.gapStart); }
    else state.gapStart = 0;
    state.samples++;
  };
  setInterval(tick, 100);
  return true;
})()`;

export async function openApp(t, script, { settings = {} } = {}) {
  const provider = await streamingProvider(script);
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-live-run-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-live-config-'));
  await writeFile(path.join(root, 'notes.txt'), 'hello\nsecond line\n');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ protocol: 'openai-compatible', baseURL: provider.url, model: 'acme/streamer', apiKey: '', configured: true }));
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify(settings));
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', OASIS_NO_UPDATE_CHECK: '1' };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-live-run-token-0123456789abcdef' });
  const browser = await Browser.launch({ env: { ...process.env, OASIS_CHROME_HEADLESS: '1' }, executable: chrome });
  t.after(async () => { await browser.close(); await app.close(); provider.server.close(); await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  const page = await browser.newPage('about:blank');
  await page.send('Runtime.enable');
  const errors = [];
  page.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails.exception ? event.exceptionDetails.exception.description : event.exceptionDetails.text));
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: 'http://127.0.0.1:' + app.port + '/app/#token=' + app.token });
  await waitFor(page, `document.readyState === 'complete' && document.documentElement.dataset.ready === '1' && document.documentElement.classList.contains('runtime') && Boolean(document.getElementById('input'))`, { label: 'app ready' });
  // OASIS_SHOTS_DIR=/tmp/x saves screenshots for design review.
  const shot = async (name) => {
    if (!process.env.OASIS_SHOTS_DIR) return;
    await mkdir(process.env.OASIS_SHOTS_DIR, { recursive: true });
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.env.OASIS_SHOTS_DIR, 'live-' + name + '.png'), Buffer.from(data, 'base64'));
  };
  if (process.env.OASIS_SHOTS_DIR) await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  return { page, errors, provider, root, shot };
}

test('a live run streams reasoning into a Thinking block that settles and survives a reload', { skip: chrome ? false : 'no Chrome/Chromium installed', timeout: 120000 }, async (t) => {
  const { page, errors, shot } = await openApp(t, [
    [{ reasoning: 'The user wants the notes. ' }, { wait: 600, reasoning: 'Reading notes.txt is enough.' }, { wait: 900, text: 'I\u2019ll read notes.txt to see what it says.' }, { wait: 300, tool: 'read_file', args: { path: 'notes.txt' } }],
    [{ wait: 1500, text: 'I\u2019ll read it again to check the second line.' }, { wait: 200, tool: 'read_file', args: { path: 'notes.txt' } }],
    [{ wait: 200, text: 'The notes say hello.' }]
  ]);
  await evaluate(page, SAMPLER);
  await evaluate(page, type('What do the notes say?'));
  await evaluate(page, submit);
  // The reasoning summary streams into the live block, opened.
  await waitFor(page, `(() => { const b = document.querySelector('#transcript .thinking.live'); return b && !b.querySelector('.thinking-text').hidden && /Reading notes\\.txt is enough/.test(b.textContent); })()`, { label: 'reasoning streams into the live Thinking block' });
  await shot('reasoning-live');
  // When the model starts writing, the block settles into a collapsed "Thought for".
  await waitFor(page, `(() => { const b = document.querySelector('#transcript .thinking.thought'); return b && /^Thought/.test(b.querySelector('.thinking-label').textContent) && b.querySelector('.thinking-text').hidden; })()`, { label: 'settled into Thought for Ns' });
  // Step 2 waits 1.5 s with no reasoning: the Thinking timer shows right after the step ends.
  await waitFor(page, `document.querySelectorAll('#transcript .tool.ok').length === 1 && Boolean(document.querySelector('#transcript .thinking.live'))`, { label: 'Thinking shows while the model works with nothing streaming' });
  await waitFor(page, `!${busy} && /The notes say hello/.test(document.getElementById('transcript').textContent)`, { label: 'answer shown' });
  const live = await evaluate(page, `JSON.stringify(window.__live)`).then(JSON.parse);
  assert.ok(live.samples > 10);
  assert.ok(live.longestGap < 1500, 'never blank for long while the model works (longest gap ' + live.longestGap + ' ms)');
  // Narration sits between the two groups as prose.
  const order = await evaluate(page, `[...document.getElementById('transcript').children].map((el) => el.classList.contains('steps') ? 'group' : el.classList.contains('thought') ? 'thought' : el.classList.contains('assistant') ? 'text' : el.classList.contains('user') ? 'user' : '').filter(Boolean).join(' ')`);
  assert.equal(order, 'user thought text group text group text');
  // Expanding shows the reasoning; a reload shows it again.
  await evaluate(page, `document.querySelector('.thinking.thought .thinking-head').click(); true`);
  assert.equal(await evaluate(page, `!document.querySelector('.thinking.thought .thinking-text').hidden`), true);
  await shot('reasoning-done');
  await evaluate(page, `location.reload(); true`);
  await waitFor(page, `document.documentElement.dataset.ready === '1' && /The notes say hello/.test(document.getElementById('transcript').textContent)`, { label: 'chat reopened after reload' });
  await waitFor(page, `(() => { const b = document.querySelector('#transcript .thinking.thought'); return b && /Reading notes\\.txt is enough/.test(b.querySelector('.thinking-text').textContent); })()`, { label: 'reasoning kept after reload' });
  assert.deepEqual(errors, []);
});
