import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const siteRoot = path.resolve('site');
const screenshotDir = path.resolve(process.env.OASIS_SCREENSHOT_DIR || 'artifacts/browser-e2e');
await mkdir(screenshotDir, { recursive: true });

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
  ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'],
  ['.cast', 'text/plain; charset=utf-8']
]);

const server = createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(siteRoot, relative);
  if (target !== siteRoot && !target.startsWith(siteRoot + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': mime.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce'
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => failedRequests.push(request.url() + ': ' + (request.failure()?.errorText || 'failed')));

  await page.goto(base, { waitUntil: 'networkidle', timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.title(), 'OASIS — Open-source coding-agent runtime');
  assert.equal(await page.locator('h1').count(), 1, 'The landing page must have one primary heading.');
  assert.match(await page.locator('h1').innerText(), /Bring the model/);
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://fahthiz.github.io/oasis/');
  assert.equal(await page.getByRole('link', { name: /Explore the browser app/ }).getAttribute('href'), './app/');
  assert.ok(await page.getByRole('link', { name: /View source on GitHub/ }).isVisible());
  assert.ok(await page.locator('#demo').isVisible());
  assert.ok(await page.locator('#interfaces').isVisible());
  assert.ok(await page.locator('#evidence').isVisible());

  const desktopWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(desktopWidth <= 1440, 'The desktop landing page must not overflow horizontally.');
  const desktopAxe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const desktopBlocking = desktopAxe.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
  if (desktopAxe.violations.length) {
    console.warn('[axe] desktop findings: ' + desktopAxe.violations.map((item) =>
      item.id + ' (' + item.impact + '): ' + item.nodes.map((node) => node.target.join(', ')).join(' | ')
    ).join(' || '));
  }
  assert.deepEqual(desktopBlocking.map((item) => item.id), [], 'The public website must not have serious or critical accessibility violations.');
  await page.screenshot({ path: path.join(screenshotDir, 'public-site-desktop.png'), fullPage: true });
  console.log('[site] desktop: title, primary actions, content sections and critical accessibility checks passed.');

  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(50);
    const overflow = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll('body *')].map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName.toLowerCase(), className: typeof element.className === 'string' ? element.className : '',
          left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
      }).filter((item) => item.width > 0 && (item.left < -1 || item.right > window.innerWidth + 1)).slice(0, 8)
    }));
    assert.ok(overflow.documentWidth <= width,
      'The public website must not overflow horizontally at ' + width + 'px. Offenders: ' + JSON.stringify(overflow.offenders));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(50);
  const menu = page.getByRole('button', { name: 'Menu' });
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  assert.ok(await menu.isVisible(), 'The compact navigation control must be visible on phones.');
  assert.equal(await menu.getAttribute('aria-expanded'), 'false');
  assert.equal(await nav.isVisible(), false, 'The mobile navigation should start closed.');
  await menu.click();
  assert.equal(await menu.getAttribute('aria-expanded'), 'true');
  assert.ok(await nav.isVisible(), 'The mobile navigation should open on activation.');
  await page.screenshot({ path: path.join(screenshotDir, 'public-site-mobile-menu.png'), fullPage: true });
  await page.keyboard.press('Escape');
  assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'Escape should close the mobile navigation.');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('menu-toggle')), true,
    'Closing the mobile navigation with Escape should return focus to its trigger.');
  await menu.click();
  await nav.getByRole('link', { name: 'Evidence' }).click();
  assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'Following a mobile navigation link should close the menu.');
  assert.equal(new URL(page.url()).hash, '#evidence', 'The Evidence navigation link should reach its section.');
  await page.evaluate(() => window.scrollTo(0, 0));
  const finalMobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(finalMobileWidth <= 390, 'The mobile landing page must remain within the viewport after navigation.');
  const mobileAxe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const mobileBlocking = mobileAxe.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
  if (mobileAxe.violations.length) {
    console.warn('[axe] mobile findings: ' + mobileAxe.violations.map((item) =>
      item.id + ' (' + item.impact + '): ' + item.nodes.map((node) => node.target.join(', ')).join(' | ')
    ).join(' || '));
  }
  assert.deepEqual(mobileBlocking.map((item) => item.id), [], 'The mobile website must not have serious or critical accessibility violations.');
  await page.screenshot({ path: path.join(screenshotDir, 'public-site-mobile.png'), fullPage: true });

  assert.deepEqual(pageErrors, [], 'The public website must not throw browser JavaScript errors.');
  assert.deepEqual(consoleErrors, [], 'The public website must not log browser console errors.');
  assert.deepEqual(failedRequests, [], 'Every public website asset must load successfully.');
  console.log('[site] mobile: 390px layout, menu open/close, keyboard navigation, section links and critical accessibility checks passed.');
  console.log('[site] browser errors: none; failed asset requests: none; screenshots: ' + screenshotDir);
  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server.listening) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
  }
}
