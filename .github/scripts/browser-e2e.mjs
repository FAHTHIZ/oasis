import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  let completionCalls = 0;
  providerServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    const request = JSON.parse(raw || '{}');
    completionCalls++;

    // Emulate a small but real agent cycle: create a file, read it back, then report.
    const toolResults = Array.isArray(request.messages)
      ? request.messages.filter((message) => message && message.role === 'tool')
      : [];
    const hasWritten = toolResults.some((message) => message.name === 'write_file');
    const hasReadBack = toolResults.some((message) => message.name === 'read_file');
    let assistantMessage;
    let finishReason = 'tool_calls';

    if (!hasWritten) {
      assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_browser_e2e_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              path: 'browser-e2e-output.txt',
              content: 'Created by the authenticated browser agent tool cycle.\n'
            })
          }
        }]
      };
    } else if (!hasReadBack) {
      assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_browser_e2e_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'browser-e2e-output.txt' })
          }
        }]
      };
    } else {
      finishReason = 'stop';
      assistantMessage = {
        role: 'assistant',
        content: 'Browser end-to-end fixture completed successfully after writing and reading back a workspace file.'
      };
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: assistantMessage, finish_reason: finishReason }],
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
  assert.equal(completionCalls, 3, 'The agent should write the file, read it back, and then produce a final answer.');
  assert.equal(
    await readFile(path.join(root, 'browser-e2e-output.txt'), 'utf8'),
    'Created by the authenticated browser agent tool cycle.\n',
    'The browser request should result in a real workspace file write.'
  );
  assert.deepEqual(pageErrors, [], 'The browser page must not throw JavaScript errors.');
  console.log('PASS browser E2E: app loaded, token connection succeeded, write/read tools ran, workspace change verified, final reply rendered.');
  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  if (providerServer && providerServer.listening) {
    await new Promise((resolve) => providerServer.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
