// Browser end-to-end smoke test for the OASIS web app (`oasis web` → /app/).
// A scripted OpenAI-compatible provider drives one real task: the app sends
// the prompt, the agent asks to write a file, the user approves it in the
// app's approval sheet, and the file appears on disk. Along the way it checks
// color contrast with axe in dark and light themes and saves desktop and
// phone screenshots (also used for the README).
//
//   npm install --no-save playwright @axe-core/playwright && npx playwright install chromium
//   node .github/scripts/browser-e2e.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { startOasisWebServer } from '../../src/web.mjs';
import { saveConfig } from '../../src/config.mjs';

const timeoutMs = 20_000;
const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-browser-e2e-'));
const project = path.join(root, 'todo-app');
const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
const token = 'oasis-browser-e2e-token-0123456789';
const screenshotDir = process.env.OASIS_SCREENSHOT_DIR || path.join(process.cwd(), 'artifacts', 'browser-e2e');
await mkdir(screenshotDir, { recursive: true });
await mkdir(project, { recursive: true });
await writeFile(path.join(project, 'math.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');
await writeFile(path.join(project, 'package.json'), '{\n  "name": "todo-app",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n');
for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'OASIS E2E'], ['config', 'user.email', 'e2e@example.test'], ['add', '-A'], ['commit', '-qm', 'start']]) execFileSync('git', args, { cwd: project });

// The scripted agent: fix the bug, add a test, review the diff, run the
// tests, answer. Each step is chosen from what has happened so far, so extra
// requests (a verification reminder, a retry) get a sensible reply.
const FIX = { path: 'math.mjs', old_string: 'return a - b;', new_string: 'return a + b;' };
const TEST = { path: 'math.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\n\ntest('add sums two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n" };
function nextStep(messages) {
  const called = new Set(messages.flatMap((m) => (m.tool_calls || []).map((c) => c.function.name + ':' + c.function.arguments)));
  const did = (name, args) => called.has(name + ':' + JSON.stringify(args));
  const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + name + '_' + called.size, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (!did('read_file', { path: 'math.mjs' })) return call('read_file', { path: 'math.mjs' });
  if (!did('edit_file', FIX)) return call('edit_file', FIX);
  if (!did('write_file', TEST)) return call('write_file', TEST);
  if (!did('git_diff', { scope: 'all' })) return call('git_diff', { scope: 'all' });
  const tests = { command: 'npm', args: ['test'] };
  const ran = messages.filter((m) => (m.tool_calls || []).some((c) => c.function.name === 'run_command')).length;
  if (ran < 1) return call('run_command', tests);
  return { role: 'assistant', content: 'Fixed `add()` in `math.mjs`: it subtracted instead of adding.\n\n- Added `math.test.mjs` with a test for `add(2, 3)`.\n- Ran `npm test`: 1 test passed.' };
}

let providerServer;
let app;
let browser;
const requests = [];
try {
  providerServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'e2e-coder' }] })); return; }
    const body = JSON.parse(raw || '{}');
    requests.push(body);
    const message = nextStep(body.messages || []);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } }));
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + providerServer.address().port + '/v1', model: 'e2e-coder', apiKey: 'e2e-key' }, { env });
  app = await startOasisWebServer({ root: project, host: '127.0.0.1', port: 0, env, token });
  const url = 'http://127.0.0.1:' + app.port + '/app/#token=' + token;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const errors = [];
  async function open(options) {
    const context = await browser.newContext({ serviceWorkers: 'block', ...options });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.locator('#welcomeTitle').waitFor({ timeout: timeoutMs });
    await page.waitForFunction(() => /e2e-coder/.test(document.getElementById('modelChip')?.textContent || ''), null, { timeout: timeoutMs });
    return { context, page };
  }
  async function contrast(page, label) {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = results.violations.filter((v) => v.id === 'color-contrast');
    const other = results.violations.filter((v) => v.id !== 'color-contrast');
    if (other.length) console.warn('[axe] ' + label + ': ' + other.map((v) => v.id + ' ' + v.nodes.map((n) => n.target.join(' ')).join(',')).join('; '));
    assert.equal(bad.length, 0, '[axe] ' + label + ' color contrast: ' + bad.flatMap((v) => v.nodes.map((n) => n.target.join(' '))).join(' | '));
    console.log('[axe] ' + label + ': no color-contrast violations');
  }

  // Desktop, dark theme: the full task.
  const { context, page } = await open({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await contrast(page, 'welcome (dark)');
  await page.screenshot({ path: path.join(screenshotDir, 'welcome-dark.png') });
  await page.locator('#input').fill('add() in math.mjs is wrong. Fix it, add a test, and run the tests.');
  await page.locator('#sendButton').click();
  // "Ask first" mode: approve each change in the app's approval sheet.
  const deadline = Date.now() + 60_000;
  let approvals = 0;
  while (Date.now() < deadline) {
    if (await page.locator('#approvalSheet').isVisible()) {
      if (approvals === 0) await page.screenshot({ path: path.join(screenshotDir, 'approval-dark.png') });
      await page.locator('#allowButton').click();
      approvals++;
      continue;
    }
    if (/1 test passed/.test(await page.locator('#transcript').innerText())) break;
    await page.waitForTimeout(150);
  }
  assert.ok(approvals >= 1, 'the edit asked for approval');
  await page.waitForFunction(() => /1 test passed/.test(document.getElementById('transcript').innerText), null, { timeout: timeoutMs });
  assert.match(await readFile(path.join(project, 'math.mjs'), 'utf8'), /return a \+ b;/);
  assert.match(await readFile(path.join(project, 'math.test.mjs'), 'utf8'), /add\(2, 3\)/);
  await page.waitForTimeout(400);
  await contrast(page, 'finished task (dark)');
  await page.screenshot({ path: path.join(screenshotDir, 'task-dark.png') });
  await page.locator('#pluginsButton').click();
  await page.locator('#pluginsSheet').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(screenshotDir, 'plugins-dark.png') });
  await context.close();

  // Light theme and phone width: the welcome screen.
  for (const [label, options] of [['light', { viewport: { width: 1440, height: 900 }, colorScheme: 'light' }], ['phone', { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true }]]) {
    const view = await open(options);
    await view.page.screenshot({ path: path.join(screenshotDir, 'welcome-' + label + '.png') });
    await contrast(view.page, 'welcome (' + label + ')');
    await view.context.close();
  }

  assert.deepEqual(errors.filter((text) => !/favicon/.test(text)), [], 'no page or console errors');
  console.log('Browser E2E passed: ' + requests.length + ' model requests, ' + approvals + ' approvals. Screenshots in ' + screenshotDir);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  if (providerServer) providerServer.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
