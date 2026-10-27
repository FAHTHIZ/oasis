import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startOasisWebServer } from '../../src/web.mjs';
import { saveConfig } from '../../src/config.mjs';

const timeoutMs = 15_000;
const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-browser-e2e-'));
const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
const token = 'oasis-browser-e2e-token-0123456789';

let providerServer;
let app;
let browser;

try {
  providerServer = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: 'Browser end-to-end fixture completed successfully.'
        }
      }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    }));
  });
  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });

  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
    model: 'oasis-browser-e2e-fixture',
    apiKey: ''
  }, { env });

  app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env,
    token
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('http://127.0.0.1:' + app.port + '/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.locator('button[data-nav="agent"]').first().click();
  await page.locator('#agentTokenInput').fill(token);
  await page.locator('#agentConnectBtn').click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#agentRuntimeState');
    return status && /connected/i.test(status.textContent) && !/not connected|connection failed/i.test(status.textContent);
  }, null, { timeout: timeoutMs });

  await page.locator('#agentPrompt').fill('Run the browser end-to-end fixture and report its result.');
  await page.locator('#agentSendBtn').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#agentMessages .agent-message.assistant')]
    .some((element) => element.textContent.includes('Browser end-to-end fixture completed successfully.')),
  null, { timeout: timeoutMs });

  const response = await page.locator('#agentMessages .agent-message.assistant').allTextContents();
  assert.ok(response.some((text) => text.includes('Browser end-to-end fixture completed successfully.')),
    'The fixture model response should be rendered in the actual agent chat UI.');
  assert.deepEqual(pageErrors, [], 'The browser page must not throw JavaScript errors.');
  console.log('PASS browser E2E: app loaded, token connection succeeded, prompt reached the runtime, model reply rendered.');
  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  if (providerServer && providerServer.listening) {
    await new Promise((resolve) => providerServer.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
