// A first-time user's tour of the OASIS web app in a real browser (Playwright).
// Where browser-e2e.mjs follows one coding task end to end, this walks through
// the rest of the app the way a new user does: every top-bar sheet opens and
// closes, the command palette finds chats and skills, a theme previews and
// reverts, Settings lists connectors, the Files tab picks up a new file, an
// attached image reaches the model and keeps its thumbnail after a reload, and
// the phone layout never scrolls sideways. Any page or console error fails it.
//
//   npm install --no-save playwright @axe-core/playwright && npx playwright install chromium
//   node .github/scripts/browser-tour.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startOasisWebServer } from '../../src/web.mjs';
import { saveConfig } from '../../src/config.mjs';

const timeoutMs = 20_000;
const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-browser-tour-'));
const project = path.join(root, 'notes');
const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
const token = 'oasis-browser-tour-token-0123456789';
const screenshotDir = process.env.OASIS_SCREENSHOT_DIR || path.join(process.cwd(), 'artifacts', 'browser-e2e');
await mkdir(screenshotDir, { recursive: true });
await mkdir(project, { recursive: true });
await writeFile(path.join(project, 'README.md'), '# Notes\n');
// A 1x1 PNG, the smallest real image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const step = (text) => console.log('[tour] ' + text);

let providerServer;
let app;
let browser;
const requests = [];
try {
  providerServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'tour-model' }] }));
    const body = JSON.parse(raw || '{}');
    requests.push(body);
    const sawImage = JSON.stringify(body.messages || []).includes('data:image/png;base64,');
    const content = sawImage ? 'I can see the image you attached: a single pixel.' : 'Hello, how can I help?';
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } }));
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + providerServer.address().port + '/v1', model: 'tour-model', apiKey: 'tour-key' }, { env });
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
    await page.waitForFunction(() => /tour-model/.test(document.getElementById('modelChip')?.textContent || ''), null, { timeout: timeoutMs });
    return { context, page };
  }
  const isLight = (page) => page.evaluate(() => document.documentElement.classList.contains('light'));
  const noSidewaysScroll = async (page, label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, label + ' scrolls sideways by ' + overflow + 'px');
  };

  const { context, page } = await open({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

  // Every sheet in the top bar opens, and Escape closes it.
  for (const [button, sheet] of [['#settingsButton', '#settingsSheet'], ['#pluginsButton', '#pluginsSheet'], ['#chatsButton', '#chatsSheet'], ['#controlRoomButton', '#controlRoomSheet'], ['#projectButton', '#projectsSheet']]) {
    // Some are only on narrow screens; the sidebar does their job on desktop.
    if (!(await page.locator(button).isVisible())) continue;
    await page.locator(button).click();
    await page.locator(sheet).waitFor({ state: 'visible', timeout: timeoutMs });
    await page.keyboard.press('Escape');
    await page.locator(sheet).waitFor({ state: 'hidden', timeout: timeoutMs });
  }
  step('every top-bar sheet opens and closes with Escape');

  // The model and mode menus close with Escape (the model menu used to stay
  // open, and Escape went on to stop a running task).
  for (const [chip, menu] of [['#modelChip', '#modelMenu'], ['#modeChip', '#modeMenu']]) {
    await page.locator(chip).click();
    await page.locator(menu).waitFor({ state: 'visible', timeout: timeoutMs });
    await page.keyboard.press('Escape');
    await page.locator(menu).waitFor({ state: 'hidden', timeout: timeoutMs });
  }
  step('the model and mode menus close with Escape');

  // Settings: connectors are listed, and a theme previews at once and reverts
  // when Settings closes without saving.
  await page.locator('#settingsButton').click();
  await page.locator('#settingsSheet').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#appList > *').length >= 10, null, { timeout: timeoutMs });
  const connectors = await page.locator('#appList > *').count();
  assert.equal(await isLight(page), false, 'starts dark');
  await page.locator('#themeSelect').selectOption('light');
  await page.waitForFunction(() => document.documentElement.classList.contains('light'), null, { timeout: timeoutMs });
  await page.keyboard.press('Escape');
  await page.locator('#settingsSheet').waitFor({ state: 'hidden' });
  assert.equal(await isLight(page), false, 'closing Settings without saving puts the old theme back');
  step('Settings lists ' + connectors + ' connectors; the theme previews and reverts');

  // Activity, Files and Changes tabs. A file made outside the app shows up
  // when the Files tab is picked.
  // On a desktop with a project open the panel starts open.
  if (await page.locator('#filesPanel').isHidden()) await page.locator('#filesButton').click();
  await page.locator('#filesPanel').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('#fileList', { hasText: 'README.md' }).waitFor({ timeout: timeoutMs });
  await writeFile(path.join(project, 'made-outside.txt'), 'hello\n');
  await page.locator('.tab[data-tab="changes"]').click();
  await page.locator('#activityTab').click();
  await page.locator('#activityView').waitFor({ state: 'visible' });
  await page.locator('.tab[data-tab="files"]').click();
  await page.locator('#fileList', { hasText: 'made-outside.txt' }).waitFor({ timeout: timeoutMs });
  step('Activity, Files and Changes open; Files picks up a new file');

  // A message with an image: the model receives it, and after a reload the
  // chat still shows the thumbnail.
  await page.locator('#attachInput').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await page.locator('#attachments img').first().waitFor({ timeout: timeoutMs });
  await page.locator('#input').fill('What is in this image?');
  await page.locator('#sendButton').click();
  await page.locator('#transcript', { hasText: 'I can see the image you attached' }).waitFor({ timeout: timeoutMs });
  assert.ok(requests.some((body) => JSON.stringify(body.messages).includes('data:image/png;base64,')), 'the model got the image');
  await page.locator('.msg.user img').first().waitFor({ timeout: timeoutMs });
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#transcript', { hasText: 'I can see the image you attached' }).waitFor({ timeout: timeoutMs });
  await page.locator('.msg.user img').first().waitFor({ timeout: timeoutMs });
  step('an attached image reaches the model and keeps its thumbnail after a reload');

  // The command palette finds actions and, from a new task, the chat just made
  // (the chat you are in is left out).
  await page.locator('#sideNewTask').click();
  await page.locator('#welcomeTitle').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('#commandPaletteButton').click();
  await page.locator('#commandPaletteDialog').waitFor({ state: 'visible' });
  await page.locator('#commandPaletteInput').fill('settings');
  await page.locator('#commandPaletteResults', { hasText: /settings/i }).waitFor({ timeout: timeoutMs });
  await page.locator('#commandPaletteInput').fill('this image');
  await page.locator('#commandPaletteResults', { hasText: 'What is in this image?' }).waitFor({ timeout: timeoutMs });
  await page.keyboard.press('Escape');
  await page.locator('#commandPaletteDialog').waitFor({ state: 'hidden' });
  step('the command palette finds actions and chats');

  // The keyboard-shortcuts list opens from the palette.
  await page.locator('#commandPaletteButton').click();
  await page.locator('#commandPaletteInput').fill('keyboard shortcuts');
  await page.keyboard.press('Enter');
  await page.locator('#shortcutsDialog').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('#shortcutsClose').click();
  await page.locator('#shortcutsDialog').waitFor({ state: 'hidden' });
  step('the keyboard shortcuts list opens and closes');
  await page.screenshot({ path: path.join(screenshotDir, 'tour-desktop.png') });
  await context.close();

  // Phone width: no sideways scrolling on the welcome screen, the chat, or Settings.
  {
    const phone = await open({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true });
    await noSidewaysScroll(phone.page, 'the phone welcome screen');
    await phone.page.locator('#sideTasks .side-task, #sideSessions .side-task').first().click({ force: true }).catch(() => {});
    await noSidewaysScroll(phone.page, 'the phone chat');
    await phone.page.locator('#settingsButton').click();
    await phone.page.locator('#settingsSheet').waitFor({ state: 'visible' });
    await noSidewaysScroll(phone.page, 'phone Settings');
    await phone.page.screenshot({ path: path.join(screenshotDir, 'tour-phone-settings.png') });
    await phone.context.close();
    step('the phone layout never scrolls sideways');
  }

  const unexpected = errors.filter((text) => !/favicon/.test(text));
  assert.deepEqual(unexpected, [], 'no page or console errors');
  console.log('Browser tour passed: ' + requests.length + ' model requests. Screenshots in ' + screenshotDir);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  if (providerServer) providerServer.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
