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
const README_SHOT = '.msg.note { display: none !important; }';
const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-browser-e2e-'));
const project = path.join(root, 'todo-app');
const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
const token = 'oasis-browser-e2e-token-0123456789';
const screenshotDir = process.env.OASIS_SCREENSHOT_DIR || path.join(process.cwd(), 'artifacts', 'browser-e2e');
await mkdir(screenshotDir, { recursive: true });
await mkdir(project, { recursive: true });
await writeFile(path.join(project, 'math.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');
await writeFile(path.join(project, 'package.json'), '{\n  "name": "todo-app",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n');
// A tool server whose program is missing: the app must say it did not start, and why.
await mkdir(env.OASIS_CONFIG_DIR, { recursive: true });
await writeFile(path.join(env.OASIS_CONFIG_DIR, 'mcp-servers.json'), JSON.stringify({ servers: [{ name: 'broken-tools', command: 'oasis-e2e-missing-program', args: [], passEnv: [], enabled: true }] }));
for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'OASIS E2E'], ['config', 'user.email', 'e2e@example.test'], ['add', '-A'], ['commit', '-qm', 'start']]) execFileSync('git', args, { cwd: project });

// The scripted agent: fix the bug, add a test, review the diff, run the
// tests, answer. Each step is chosen from what has happened so far, so extra
// requests (a verification reminder, a retry) get a sensible reply.
const FIX = { path: 'math.mjs', old_string: 'return a - b;', new_string: 'return a + b;' };
const TEST = { path: 'math.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\n\ntest('add sums two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n" };
function nextStep(messages) {
  const called = new Set(messages.flatMap((m) => (m.tool_calls || []).map((c) => c.function.name + ':' + c.function.arguments)));
  const did = (name, args) => called.has(name + ':' + JSON.stringify(args));
  const call = (name, args, say = null) => ({ role: 'assistant', content: say, tool_calls: [{ id: 'call_' + name + '_' + called.size, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  // A subagent's own requests start from its prompt; it answers at once.
  const firstUser = messages.find((m) => m.role === 'user');
  const firstText = firstUser ? (typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content)) : '';
  if (firstText.includes('E2E-SUBAGENT')) return { role: 'assistant', content: 'math.mjs exports add(), which subtracts.' };
  const SUB = { description: 'Find the add() function', prompt: 'E2E-SUBAGENT: find where add() is defined.', subagent_type: 'explore' };
  if (!did('task', SUB)) return call('task', SUB, 'I will find where `add()` is defined first.');
  if (!did('read_file', { path: 'math.mjs' })) return call('read_file', { path: 'math.mjs' });
  if (!did('edit_file', FIX)) return call('edit_file', FIX, 'Found it: `add()` subtracts. Fixing it and adding a test.');
  if (!did('write_file', TEST)) return call('write_file', TEST);
  if (!did('git_diff', { scope: 'all' })) return call('git_diff', { scope: 'all' });
  const tests = { command: 'npm', args: ['test'] };
  const ran = messages.filter((m) => (m.tool_calls || []).some((c) => c.function.name === 'run_command')).length;
  if (ran < 1) return call('run_command', tests, 'Change reviewed. Running the tests now.');
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
  // The busy-folder check below causes exactly one expected 409, which Chromium logs.
  let expectedConflicts = 0;
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
    // Every WCAG 2 A and AA rule axe checks, not only contrast.
    const detail = results.violations.map((v) => v.id + ' ' + v.nodes.map((n) => n.target.join(' ')).join(',')).join('; ');
    assert.equal(results.violations.length, 0, '[axe] ' + label + ': ' + detail);
    console.log('[axe] ' + label + ': no WCAG 2 A/AA violations');
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
  let reloaded = false;
  let approvalShot = false;
  while (Date.now() < deadline) {
    if (await page.locator('#approvalSheet').isVisible()) {
      if (!approvalShot) {
        approvalShot = true;
        // README image: leave out the note about the tool server this test breaks on purpose.
        await page.screenshot({ path: path.join(screenshotDir, 'approval-dark.png'), style: README_SHOT });
        await contrast(page, 'approval open (dark)');
        // The step behind an open approval waits on the user; it must not say "Working".
        if (await page.locator('.tool.running:not(.waiting)').count()) throw new Error('A step behind the approval sheet still says Working');
        console.log('[approval] waiting steps:', await page.locator('.tool.waiting').count());
      }
      if (!reloaded) {
        // Session recovery: reloading mid-task (closed tab, dropped Wi-Fi)
        // reattaches to the running job and asks the same question again.
        reloaded = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#approvalSheet').waitFor({ state: 'visible', timeout: timeoutMs });
        assert.match(await page.locator('#transcript').innerText(), /add\(\) in math\.mjs is wrong/, 'the restored chat keeps the request');
        assert.equal(await page.locator('.msg.user').count(), 1, 'the request is not shown twice after a reload');
        console.log('[resume] reload reattached to the running task');
        // The server says which conversation is running and its live job.
        const live = await page.evaluate(async () => {
          const token = sessionStorage.getItem('oasis.web.token');
          const response = await fetch('/api/sessions', { headers: { authorization: 'Bearer ' + token } });
          return ((await response.json()).sessions || []).filter((item) => item.running);
        });
        assert.equal(live.length, 1, 'one running session');
        assert.match(live[0].jobId || '', /^[0-9a-f-]{36}$/, 'the running session names its job');
        assert.match(live[0].prompt || '', /add\(\) in math\.mjs is wrong/);
        // Switching to a new task leaves this one running (it used to cancel it);
        // coming back reattaches and asks the same approval again.
        await page.locator('#sideNewTask').click();
        await page.locator('#welcomeTitle').waitFor({ state: 'visible', timeout: timeoutMs });
        assert.equal(await page.locator('#approvalSheet').isVisible(), false, 'the approval belongs to the other task');
        const away = page.locator('#sideTasks .side-task.running:not(.current)');
        await away.first().waitFor({ timeout: timeoutMs });
        await away.first().click();
        await page.locator('#approvalSheet').waitFor({ state: 'visible', timeout: timeoutMs });
        assert.equal(await page.locator('.msg.user').count(), 1, 'the request is shown once after switching back');
        console.log('[resume] switching tasks kept it running; switching back reattached');
        // A second browser (another laptop or a phone) finds the running task
        // under "Other devices and terminal" and answers the approval; the
        // first browser's card closes instead of waiting for a click.
        const other = await open({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
        const elsewhere = other.page.locator('#sideSessions .side-task.running');
        await elsewhere.first().waitFor({ timeout: timeoutMs });
        // Sending there first is turned away (one task per folder), and the
        // note names the running task with a button that opens it.
        expectedConflicts++;
        await other.page.locator('#input').fill('Write a README for this project.');
        await other.page.locator('#sendButton').click();
        const busyCard = other.page.locator('.msg.error', { hasText: 'still working on "add() in math.mjs is wrong' });
        await busyCard.waitFor({ timeout: timeoutMs });
        assert.equal(await busyCard.getByRole('button', { name: 'Stop it and send this' }).count(), 1, 'the busy note offers to stop the running task');
        await busyCard.getByRole('button', { name: 'Open the running task' }).click();
        await other.page.locator('#approvalSheet').waitFor({ state: 'visible', timeout: timeoutMs });
        console.log('[busy] a second task in the same folder was turned away with a way to open the running one');
        await other.page.locator('#transcript .msg.user', { hasText: 'add() in math.mjs is wrong' }).first().waitFor({ timeout: timeoutMs });
        const otherText = await other.page.locator('#transcript').innerText();
        assert.equal((otherText.match(/Ran the explore agent/g) || []).length, 1, 'the other browser shows each step once');
        await other.page.locator('#allowButton').click();
        await page.locator('#approvalSheet').waitFor({ state: 'hidden', timeout: timeoutMs });
        await page.locator('.toast', { hasText: 'answered on another device' }).waitFor({ timeout: timeoutMs });
        await other.context.close();
        approvals++;
        console.log('[devices] an approval answered in another browser closed here');
        continue;
      }
      // The step behind an open approval waits on the user; it must not say "Working".
      const stuck = await page.locator('.tool.running:not(.waiting)').count();
      if (stuck) throw new Error('A step behind the approval sheet still says Working');
      if (approvals <= 1) console.log('[approval] waiting steps:', await page.locator('.tool.waiting').count());
      await page.locator('#allowButton').click();
      approvals++;
      continue;
    }
    if (/1 test passed/.test(await page.locator('#transcript').innerText())) break;
    await page.waitForTimeout(150);
  }
  assert.ok(approvals >= 1, 'the edit asked for approval');
  // Finished work folds into execution groups; a person opens one to see
  // the subagent and the exact steps.
  await page.waitForFunction(() => /1 test passed/.test(document.getElementById('transcript').innerText), null, { timeout: timeoutMs });
  // Prose updates and execution groups alternate, like a person narrating the work.
  const flow = await page.evaluate(() => [...document.getElementById('transcript').children].map((el) => el.classList.contains('steps') ? 'steps' : el.classList.contains('assistant') ? 'text' : el.classList.contains('user') ? 'user' : 'other').filter((kind) => kind !== 'other'));
  assert.deepEqual(flow, ['user', 'text', 'steps', 'text', 'steps', 'text', 'steps', 'text'], 'timeline order: ' + flow.join(' '));
  assert.equal(await page.locator('.steps.running').count(), 0, 'no group still says it is running');
  const firstGroup = page.locator('.steps').first();
  if ((await firstGroup.locator('.steps-head').getAttribute('aria-expanded')) !== 'true') await firstGroup.locator('.steps-head').click();
  await page.locator('.subagents .subagent').first().waitFor({ timeout: timeoutMs });
  assert.match(await page.locator('.subagents').innerText(), /Find the add\(\) function[\s\S]*Done/);
  await page.waitForFunction(() => /1 test passed/.test(document.getElementById('transcript').innerText), null, { timeout: timeoutMs });
  assert.match(await readFile(path.join(project, 'math.mjs'), 'utf8'), /return a \+ b;/);
  assert.match(await readFile(path.join(project, 'math.test.mjs'), 'utf8'), /add\(2, 3\)/);
  assert.match(await page.locator('.msg.note').allInnerTexts().then((texts) => texts.join('\n')), /A tool server did not start\. broken-tools: the program "oasis-e2e-missing-program" is not installed or not on your PATH\./);
  await page.waitForTimeout(400);
  await contrast(page, 'finished task (dark)');
  await page.screenshot({ path: path.join(screenshotDir, 'task-dark.png') });
  await page.locator('#pluginsButton').click();
  await page.locator('#pluginsSheet').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(screenshotDir, 'plugins-dark.png') });
  await context.close();

  // README hero: the finished task opened from the sidebar in a fresh browser,
  // the way someone reviews it later. No reconnect toast and no note about the
  // tool server this test breaks on purpose.
  {
    const hero = await open({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await hero.page.locator('#sideTasks .side-task, #sideSessions .side-task').first().click();
    await hero.page.waitForFunction(() => /1 test passed/.test(document.getElementById('transcript').innerText), null, { timeout: timeoutMs });
    const group = hero.page.locator('.steps').first();
    if (await group.count() && (await group.locator('.steps-head').getAttribute('aria-expanded')) !== 'true') await group.locator('.steps-head').click();
    await hero.page.locator('.toast').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    await hero.page.waitForTimeout(400);
    await contrast(hero.page, 'reopened task (dark)');
    await hero.page.screenshot({ path: path.join(screenshotDir, 'hero-dark.png') });
    assert.equal(await hero.page.locator('.steps').count(), 3, 'the reopened task keeps its three execution groups');
    assert.match(await hero.page.locator('.subagents, .steps').first().innerText(), /explore/i, 'the reopened task shows the subagent step');
    console.log('[hero] reopened task shows its steps');
    await hero.context.close();
  }

  // Light theme and phone width: the welcome screen.
  for (const [label, options] of [['light', { viewport: { width: 1440, height: 900 }, colorScheme: 'light' }], ['phone', { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true }]]) {
    const view = await open(options);
    await view.page.screenshot({ path: path.join(screenshotDir, 'welcome-' + label + '.png') });
    await contrast(view.page, 'welcome (' + label + ')');
    await view.context.close();
  }

  // Remote sign-in: a browser without the key sees the sign-in screen, pastes
  // the link, ticks "Remember this device", and a new tab reconnects on its own.
  {
    const bare = 'http://127.0.0.1:' + app.port + '/app/';
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(bare, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(() => /Paste your OASIS link/.test(document.getElementById('welcomeTitle')?.textContent || ''), null, { timeout: timeoutMs });
    await page.locator('#rememberRow').waitFor({ state: 'visible' });
    await contrast(page, 'sign-in (dark)');
    await page.screenshot({ path: path.join(screenshotDir, 'sign-in-dark.png') });
    await page.locator('#connectInput').fill(url);
    await page.locator('#rememberDevice').check();
    await page.locator('#connectButton').click();
    await page.waitForFunction(() => /e2e-coder/.test(document.getElementById('modelChip')?.textContent || ''), null, { timeout: timeoutMs });
    const second = await context.newPage();
    await second.goto(bare, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await second.waitForFunction(() => /e2e-coder/.test(document.getElementById('modelChip')?.textContent || ''), null, { timeout: timeoutMs });
    console.log('[sign-in] remembered device reconnected in a new tab');
    await context.close();
  }

  const unexpected = errors.filter((text) => !/favicon/.test(text)).filter((text) => !(/status of 409 \(Conflict\)/.test(text) && expectedConflicts-- > 0));
  assert.deepEqual(unexpected, [], 'no page or console errors');
  console.log('Browser E2E passed: ' + requests.length + ' model requests, ' + approvals + ' approvals. Screenshots in ' + screenshotDir);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  if (providerServer) providerServer.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
