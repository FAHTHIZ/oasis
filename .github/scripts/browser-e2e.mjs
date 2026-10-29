import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startOasisWebServer } from '../../src/web.mjs';
import { saveConfig } from '../../src/config.mjs';

const timeoutMs = 15_000;
const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-browser-e2e-'));
const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
const token = 'oasis-browser-e2e-token-0123456789';
const screenshotDir = process.env.OASIS_SCREENSHOT_DIR || path.join(process.cwd(), 'artifacts', 'browser-e2e');
await mkdir(screenshotDir, { recursive: true });

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
    console.log('Browser E2E fixture provider request ' + completionCalls + ' (' +
      (Array.isArray(request.messages) ? request.messages.length : 0) + ' messages)');

    // Keep the fixture deterministic: first create a file, then read it, then report.
    let assistantMessage;
    let finishReason = 'tool_calls';
    if (completionCalls === 1) {
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
    } else if (completionCalls === 2) {
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
    } else if (completionCalls === 3) {
      finishReason = 'stop';
      assistantMessage = {
        role: 'assistant',
        content: 'Browser end-to-end fixture completed successfully. The agent wrote and read back a workspace file.'
      };
    } else if (completionCalls === 4) {
      assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_browser_e2e_delete',
          type: 'function',
          function: {
            name: 'delete_file',
            arguments: JSON.stringify({ path: 'browser-e2e-output.txt' })
          }
        }]
      };
    } else if (completionCalls === 5) {
      finishReason = 'stop';
      assistantMessage = {
        role: 'assistant',
        content: 'The delete request was denied; the file remains unchanged.'
      };
    } else if (completionCalls === 6) {
      assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_browser_e2e_cancel',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: JSON.stringify({
              command: 'node',
              args: ['-e', 'require("node:fs").writeFileSync("cancel-e2e-side-effect.txt", "ran")']
            })
          }
        }]
      };
    } else {
      finishReason = 'stop';
      assistantMessage = {
        role: 'assistant',
        content: 'The cancellation fixture unexpectedly advanced to another model turn.'
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

  // Ctrl+K opens the browser palette. A selection fills the composer but must
  // not start an agent task; the user explicitly presses Send afterwards.
  await page.keyboard.press('Control+k');
  await page.locator('#commandPaletteSearch').fill('Find a bug');
  await page.locator('[data-palette-id="starter-find-bug"]').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#commandPaletteResults [role="option"]').count(), 1, 'Fuzzy search should narrow to the matching starter.');
  await page.locator('[data-palette-id="starter-find-bug"]').click();
  assert.equal(await page.locator('#agentPrompt').inputValue(), 'Find a bug');
  assert.equal(await page.locator('#agentMessages .agent-message.user').count(), 0, 'Selecting a starter must not send a message.');

  await page.keyboard.press('Control+k');
  await page.locator('#commandPaletteSearch').fill('provider setup');
  await page.locator('[data-palette-id="provider-setup"]').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#commandPaletteDialog').isVisible(), false, 'Escape should close the palette without running the selection.');

  await page.screenshot({ path: path.join(screenshotDir, 'workspace-before.png'), fullPage: true });
  await page.locator('button[data-nav="agent"]').first().click();
  // The starter cards belong to the empty-state UI, so test them before connecting.
  await page.locator('[data-agent-example="Explain this project"]').click();
  assert.equal(await page.locator('#agentPrompt').inputValue(), 'Explain this project', 'Starter prompt cards should fill the chat composer.');
  await page.locator('#agentTokenInput').fill(token);
  await page.locator('#agentConnectBtn').click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#agentRuntimeState');
    return status && /connected/i.test(status.textContent) && !/not connected|connection failed/i.test(status.textContent);
  }, null, { timeout: timeoutMs });
  await page.locator('#agentPrompt').fill('Run the browser end-to-end fixture and report its result.');
  await page.locator('#agentSendBtn').click();
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('#agentMessages .agent-message.assistant')]
      .some((element) => element.textContent.includes('Browser end-to-end fixture completed successfully.')),
    null, { timeout: timeoutMs });
  } catch (error) {
    const messages = await page.locator('#agentMessages').innerText().catch(() => '[messages unavailable]');
    throw new Error(String(error && error.message || error) +
      '; fixture provider calls=' + completionCalls +
      '; runtime state=' + await page.locator('#agentRuntimeState').innerText().catch(() => '[state unavailable]') +
      '; chat messages=' + JSON.stringify(messages) +
      '; page errors=' + JSON.stringify(pageErrors));
  }

  const response = await page.locator('#agentMessages .agent-message.assistant').allTextContents();
  assert.ok(response.some((text) => text.includes('Browser end-to-end fixture completed successfully.')),
    'The fixture model response should be rendered in the actual agent chat UI.');
  assert.equal(completionCalls, 3, 'The agent should write the file, read it back, and then produce a final answer.');
  assert.equal(
    await readFile(path.join(root, 'browser-e2e-output.txt'), 'utf8'),
    'Created by the authenticated browser agent tool cycle.\n',
    'The browser request should result in a real workspace file write.'
  );

  // Destructive actions should be explained in plain language and remain denyable.
  await page.locator('#agentPrompt').fill('Delete browser-e2e-output.txt from this workspace. Ask before deleting it.');
  await page.locator('#agentSendBtn').click();
  await page.locator('#agentApprovalCard').waitFor({ state: 'visible', timeout: timeoutMs });
  const approvalText = await page.locator('#agentApprovalPrompt').innerText();
  assert.match(approvalText, /WARNING — RISKY ACTION/);
  assert.match(approvalText, /browser-e2e-output\.txt/);
  assert.match(approvalText, /backup will be made first/i);
  assert.equal(await page.locator('#agentStopBtn').isEnabled(), true, 'Stop should remain available while a task is waiting for approval.');
  await page.locator('#agentDenyBtn').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#agentMessages .agent-message.assistant')]
    .some((element) => element.textContent.includes('The delete request was denied; the file remains unchanged.')),
  null, { timeout: timeoutMs });
  assert.equal(completionCalls, 5, 'The denial should be reported to the model without running the delete operation.');
  assert.equal(
    await readFile(path.join(root, 'browser-e2e-output.txt'), 'utf8'),
    'Created by the authenticated browser agent tool cycle.\n',
    'Denying the delete approval must leave the file intact.'
  );
  await page.waitForFunction(() => document.querySelector('#agentStopBtn')?.hidden === true, null, { timeout: timeoutMs });

  // A running task can be stopped while it is blocked at a command approval.
  await page.locator('#agentPrompt').fill('Run the cancellation fixture command after getting my approval.');
  await page.locator('#agentSendBtn').click();
  await page.locator('#agentApprovalCard').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#agentStopBtn').isEnabled(), true, 'Stop should be enabled while command approval is pending.');
  await page.locator('#agentStopBtn').click();
  await page.waitForFunction(() => /cancelled/i.test(document.querySelector('#agentRuntimeState')?.textContent || ''), null, { timeout: timeoutMs });
  assert.equal(completionCalls, 6, 'Cancellation must abort the task before another model request.');
  await assert.rejects(readFile(path.join(root, 'cancel-e2e-side-effect.txt')), { code: 'ENOENT' });
  assert.deepEqual(pageErrors, [], 'The browser page must not throw JavaScript errors.');
  await page.locator('#agentSplitDivider').focus();
  const splitBefore = await page.locator('#agentSplitDivider').getAttribute('aria-valuenow');
  await page.keyboard.press('ArrowRight');
  const splitAfter = await page.locator('#agentSplitDivider').getAttribute('aria-valuenow');
  assert.notEqual(splitAfter, splitBefore, 'Keyboard arrows should resize the chat/terminal divider.');

  await page.locator('#agentTerminalToggle').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'false', 'The desktop terminal toggle should hide the terminal.');
  await page.locator('#agentTerminalToggle').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'true', 'The desktop terminal toggle should restore the terminal.');

  await page.screenshot({ path: path.join(screenshotDir, 'workspace-after-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#agentTerminalTab').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-active-panel'), 'terminal', 'The terminal tab should reveal the terminal on narrow screens.');
  await page.locator('#agentChatTab').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-active-panel'), 'chat', 'The chat tab should return to chat on narrow screens.');
  await page.screenshot({ path: path.join(screenshotDir, 'workspace-after-390px.png'), fullPage: true });
  console.log('PASS browser E2E: app loaded, token connection succeeded, write/read tools ran, workspace change verified, final reply rendered.');

  // Exercise the unconfigured first-run journey in a separate, isolated config directory.
  const firstRunEnv = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'first-run-config') };
  for (const name of ['OASIS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OASIS_LOCAL_API_KEY']) delete firstRunEnv[name];
  const firstRunApp = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0, env: firstRunEnv,
    token: 'oasis-first-run-e2e-token-0123456789'
  });
  try {
    const firstRunPage = await context.newPage();
    const firstRunErrors = [];
    firstRunPage.on('pageerror', (error) => firstRunErrors.push(error.message));
    await firstRunPage.setViewportSize({ width: 1280, height: 900 });
    await firstRunPage.goto('http://127.0.0.1:' + firstRunApp.port + '/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await firstRunPage.locator('button[data-nav="agent"]').first().click();
    await firstRunPage.locator('#agentTokenInput').fill(firstRunApp.token);
    await firstRunPage.locator('#agentConnectBtn').click();
    await firstRunPage.locator('#firstRunWizard').waitFor({ state: 'visible', timeout: timeoutMs });
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-desktop.png'), fullPage: true });
    await firstRunPage.setViewportSize({ width: 390, height: 844 });
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-390px.png'), fullPage: true });
    assert.equal(await firstRunPage.locator('[data-first-run]').count(), 3, 'First run should present all three model choices.');
    assert.deepEqual(firstRunErrors, [], 'The first-run screen must not throw JavaScript errors.');
    await firstRunPage.close();
    console.log('PASS first-run E2E: unconfigured provider exposes all three setup paths at desktop and 390px.');
  } finally {
    await firstRunApp.close();
  }
  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  if (providerServer && providerServer.listening) {
    await new Promise((resolve) => providerServer.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
