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

const timeoutMs = 15_000;
const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-browser-e2e-'));
const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
// The isolated-diff E2E uses a real, clean Git repository. Runtime state lives
// outside the tracked project files so the isolation precondition remains real.
await writeFile(path.join(root, '.gitignore'), 'config/\nfirst-run-config/\n');
execFileSync('git', ['init', '--quiet'], { cwd: root });
execFileSync('git', ['config', 'user.name', 'OASIS Browser E2E'], { cwd: root });
execFileSync('git', ['config', 'user.email', 'oasis-browser-e2e@example.test'], { cwd: root });
execFileSync('git', ['add', '.gitignore'], { cwd: root });
execFileSync('git', ['commit', '--quiet', '-m', 'Browser E2E workspace baseline'], { cwd: root });
const token = 'oasis-browser-e2e-token-0123456789';
const screenshotDir = process.env.OASIS_SCREENSHOT_DIR || path.join(process.cwd(), 'artifacts', 'browser-e2e');
await mkdir(screenshotDir, { recursive: true });

async function assertAgentContrast(page, label) {
  const results = await new AxeBuilder({ page })
    .include('#view-agent')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');
  const other = results.violations.filter((violation) => violation.id !== 'color-contrast');
  if (other.length) {
    console.warn('[axe] ' + label + ': other accessibility findings: ' +
      other.map((violation) => violation.id + ' (' + violation.impact + ')').join(', '));
  }
  const detail = contrast.map((violation) =>
    violation.nodes.map((node) => violation.id + ' ' + node.target.join(', ') + ': ' +
      String(node.failureSummary || violation.help).replace(/\\s+/g, ' ').slice(0, 280)).join('\\n')
  ).join('\\n');
  assert.equal(contrast.length, 0, '[axe] ' + label + ' has color-contrast violations:\\n' + detail);
  console.log('[axe] ' + label + ': no color-contrast violations (' + results.passes.length + ' passing rules).');
}

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
    } else if (completionCalls === 7) {
      assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_browser_e2e_worktree_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              path: 'review-e2e-output.txt',
              content: 'Created in the isolated worktree for diff review.\n'
            })
          }
        }]
      };
    } else if (completionCalls === 8) {
      assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_browser_e2e_worktree_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'review-e2e-output.txt' })
          }
        }]
      };
    } else if (completionCalls === 9) {
      finishReason = 'stop';
      assistantMessage = {
        role: 'assistant',
        content: 'Isolated worktree fixture completed successfully. I read back the new file and the review branch is ready.'
      };
    } else {
      finishReason = 'stop';
      assistantMessage = {
        role: 'assistant',
        content: 'Unexpected extra browser E2E model request.'
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
  await assertAgentContrast(page, 'Agent empty state · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-empty-desktop.png'), fullPage: true });
  // The starter cards belong to the empty-state UI, so test them before connecting.
  await page.locator('[data-agent-example="Explain this project"]').click();
  assert.equal(await page.locator('#agentPrompt').inputValue(), 'Explain this project', 'Starter prompt cards should fill the chat composer.');

  // A rejected runtime token must leave the chat usable and explain the failure.
  await page.locator('#agentTokenInput').fill('oasis-invalid-browser-e2e-token');
  await page.locator('#agentConnectBtn').click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#agentRuntimeState');
    return status && status.textContent.includes('Connection failed');
  }, null, { timeout: timeoutMs });
  await assertAgentContrast(page, 'Agent connection error · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-connection-error-desktop.png'), fullPage: true });

  await page.locator('#agentTokenInput').fill(token);
  await page.locator('#agentConnectBtn').click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#agentRuntimeState');
    return status && /connected/i.test(status.textContent) && !/not connected|connection failed/i.test(status.textContent);
  }, null, { timeout: timeoutMs });
  await assertAgentContrast(page, 'Agent workspace · desktop');
  await page.locator('#agentModelButton').click();
  await page.waitForFunction(() => window.scrollY > 0, null, { timeout: timeoutMs });
  await assertAgentContrast(page, 'Agent provider settings · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-provider-settings-desktop.png'), fullPage: true });
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

  await page.screenshot({ path: path.join(screenshotDir, 'agent-chat-desktop.png'), fullPage: true });
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
  await assertAgentContrast(page, 'Agent approval card');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-approval-desktop.png'), fullPage: true });
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

  // The right utility rail should switch between the live terminal and saved
  // coding runs/diffs without leaving the conversation workspace.
  await page.locator('#agentRunsUtilityTab').click();
  assert.equal(await page.locator('#agentRunsUtilityTab').getAttribute('aria-selected'), 'true');
  await page.locator('#agentRunsUtilityPanel').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#agentTerminalUtilityPanel').isVisible(), false, 'The terminal utility panel should hide while Runs & changes is selected.');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#agentTerminalUtilityTab').getAttribute('aria-selected'), 'true', 'Left arrow should select Terminal.');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#agentRunsUtilityTab').getAttribute('aria-selected'), 'true', 'Right arrow should select Runs & changes.');
  await assertAgentContrast(page, 'Runs and changes · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-runs-desktop.png'), fullPage: true });
  await page.locator('#agentTerminalUtilityTab').click();
  assert.equal(await page.locator('#agentTerminalUtilityPanel').isVisible(), true, 'The terminal utility panel should be restored by its tab.');

  // Commit the output from the preceding non-isolated file test so the real
  // worktree run begins from a clean user workspace, as required in production.
  execFileSync('git', ['add', 'browser-e2e-output.txt'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'Commit browser chat fixture output'], { cwd: root });
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '',
    'The primary checkout must be clean before creating an isolated worktree.');

  // Saved-chat recovery must reopen the parent chat without restarting workers.
  await page.locator('button[data-nav="monitor"]').click();
  const originalRun = page.locator('#agentMonitorRunList .agent-monitor-run')
    .filter({ hasText: 'Run the browser end-to-end fixture and report its result.' });
  await originalRun.waitFor({ state: 'visible', timeout: timeoutMs });
  await originalRun.click();
  await page.waitForFunction(() => {
    const heading = document.querySelector('#agentMonitorDetailTitle')?.textContent || '';
    const button = document.querySelector('#agentMonitorOpenSessionBtn');
    return heading.includes('Run the browser end-to-end fixture and report its result.') && button && !button.hidden;
  }, null, { timeout: timeoutMs });
  assert.equal(await page.locator('#agentMonitorOpenSessionBtn').innerText(), 'Open saved chat',
    'A completed workspace run should offer its saved parent chat, not a worker-resume action.');
  await page.locator('#agentMonitorOpenSessionBtn').click();
  await page.waitForFunction(() => {
    const agentView = document.querySelector('#view-agent');
    const users = [...document.querySelectorAll('#agentMessages .agent-message.user')];
    const assistants = [...document.querySelectorAll('#agentMessages .agent-message.assistant')];
    return agentView?.classList.contains('active') &&
      users.some((element) => element.textContent.includes('Run the browser end-to-end fixture and report its result.')) &&
      assistants.some((element) => element.textContent.includes('Browser end-to-end fixture completed successfully.'));
  }, null, { timeout: timeoutMs });
  console.log('PASS saved-chat recovery: the monitor reopened the saved parent conversation without restarting a worker.');

  // A running task can be stopped while it is blocked at a command approval.
  await page.locator('#agentPrompt').fill('Run the cancellation fixture command after getting my approval.');
  await page.locator('#agentSendBtn').click();
  await page.locator('#agentApprovalCard').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#agentStopBtn').isEnabled(), true, 'Stop should be enabled while command approval is pending.');
  await page.locator('#agentStopBtn').click();
  await page.waitForFunction(() => /cancelled/i.test(document.querySelector('#agentRuntimeState')?.textContent || ''), null, { timeout: timeoutMs });
  assert.equal(completionCalls, 6, 'Cancellation must abort the task before another model request.');
  await assert.rejects(readFile(path.join(root, 'cancel-e2e-side-effect.txt')), { code: 'ENOENT' });

  // The isolated run should create a committed branch artifact without changing
  // the primary checkout, then the monitor should open that exact diff for review.
  const mainHeadBeforeWorktree = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '',
    'The primary checkout must be clean before starting the isolated task.');
  await page.locator('#agentIsolateWorktree').check();
  await page.locator('#agentPrompt').fill('Run the isolated worktree fixture and prepare changes for review.');
  await page.locator('#agentSendBtn').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#agentMessages .agent-message.assistant')]
    .some((element) => element.textContent.includes('Isolated worktree fixture completed successfully.')),
  null, { timeout: timeoutMs });
  await page.waitForFunction(() => document.querySelector('#agentStopBtn')?.hidden === true, null, { timeout: timeoutMs });
  assert.equal(completionCalls, 9, 'The isolated task should write the file, read it back for verification, and then finish.');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), mainHeadBeforeWorktree,
    'Finishing isolated work must not advance the primary branch.');
  assert.ok(execFileSync('git', ['branch', '--list', 'oasis/*'], { cwd: root, encoding: 'utf8' }).trim(),
    'The isolated change must remain on a separate review branch.');
  await assert.rejects(readFile(path.join(root, 'review-e2e-output.txt')), { code: 'ENOENT' });

  await page.locator('button[data-nav="monitor"]').click();
  const isolatedRun = page.locator('#agentMonitorRunList .agent-monitor-run')
    .filter({ hasText: 'Run the isolated worktree fixture and prepare changes for review.' });
  await isolatedRun.waitFor({ state: 'visible', timeout: timeoutMs });
  await isolatedRun.click();
  await page.waitForFunction(() => {
    const button = document.querySelector('#agentMonitorReviewRunBtn');
    return button && !button.hidden;
  }, null, { timeout: timeoutMs });
  await page.locator('#agentMonitorReviewRunBtn').click();
  await page.waitForFunction(() => {
    const wrap = document.querySelector('#cloudRunDiffDetail');
    const heading = document.querySelector('#cloudRunDiffTitle')?.textContent || '';
    const diff = document.querySelector('#cloudRunDiffText')?.textContent || '';
    return wrap && !wrap.hidden && heading.includes('Committed preview') &&
      diff.includes('review-e2e-output.txt') && diff.includes('Created in the isolated worktree for diff review.');
  }, null, { timeout: timeoutMs });
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), mainHeadBeforeWorktree,
    'Opening the isolated diff must not merge the worktree or change the main branch.');
  await page.locator('#cloudRunDiffClose').click();
  await page.locator('#cloudRunDetailClose').click();
  console.log('PASS isolated-diff review: Run Monitor opened the committed branch diff and left the main checkout untouched.');

  assert.deepEqual(pageErrors, [], 'The browser page must not throw JavaScript errors.');
  await page.locator('#agentSplitDivider').focus();
  const splitBefore = await page.locator('#agentSplitDivider').getAttribute('aria-valuenow');
  await page.keyboard.press('ArrowRight');
  const splitAfter = await page.locator('#agentSplitDivider').getAttribute('aria-valuenow');
  assert.notEqual(splitAfter, splitBefore, 'Keyboard arrows should resize the chat/terminal divider.');

  assert.equal(await page.locator('#agentTerminalToggle').innerText(), 'Hide side panel', 'The desktop visibility control should identify the complete utility rail.');
  await page.locator('#agentTerminalToggle').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'false', 'The desktop utility toggle should hide the side panel.');
  assert.equal(await page.locator('#agentTerminalToggle').innerText(), 'Show side panel');
  await page.locator('#agentTerminalToggle').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'true', 'The desktop utility toggle should restore the side panel.');
  assert.equal(await page.locator('#agentTerminalToggle').innerText(), 'Hide side panel');

  await page.screenshot({ path: path.join(screenshotDir, 'workspace-after-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDocumentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(mobileDocumentWidth <= 390, 'The Agent workspace must not overflow horizontally at 390px.');
  await page.locator('#agentTerminalTab').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-active-panel'), 'terminal', 'The terminal tab should reveal the terminal on narrow screens.');
  await assertAgentContrast(page, 'Agent terminal panel · 390px');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-terminal-390px.png'), fullPage: true });
  await page.locator('#agentRunsUtilityTab').click();
  await page.locator('#agentRunsUtilityPanel').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#agentTerminalUtilityPanel').isVisible(), false);
  await assertAgentContrast(page, 'Runs and changes · 390px');
  const utilityMobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(utilityMobileWidth <= 390, 'Runs and changes must not overflow horizontally at 390px.');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-runs-390px.png'), fullPage: true });
  await page.locator('#agentTerminalUtilityTab').click();
  assert.equal(await page.locator('#agentTerminalUtilityPanel').isVisible(), true);
  await page.locator('#agentChatTab').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-active-panel'), 'chat', 'The chat tab should return to chat on narrow screens.');
  await assertAgentContrast(page, 'Agent chat · 390px');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-chat-390px.png'), fullPage: true });
  await page.locator('#agentModelButton').click();
  await assertAgentContrast(page, 'Agent provider settings · 390px');
  const providerMobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(providerMobileWidth <= 390, 'Provider settings must not overflow horizontally at 390px.');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-provider-settings-390px.png'), fullPage: true });
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
    await assertAgentContrast(firstRunPage, 'First-run setup · desktop');
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-desktop.png'), fullPage: true });
    await firstRunPage.setViewportSize({ width: 390, height: 844 });
    const firstRunMobileWidth = await firstRunPage.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(firstRunMobileWidth <= 390, 'The first-run screen must not overflow horizontally at 390px.');
    await assertAgentContrast(firstRunPage, 'First-run setup · 390px');
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
