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
await mkdir(path.join(root, '.oasis'), { recursive: true });
await writeFile(path.join(root, '.oasis', 'settings.json'), '{"theme":"dark"}\n');
execFileSync('git', ['init', '--quiet'], { cwd: root });
execFileSync('git', ['config', 'user.name', 'OASIS Browser E2E'], { cwd: root });
execFileSync('git', ['config', 'user.email', 'oasis-browser-e2e@example.test'], { cwd: root });
execFileSync('git', ['add', '.gitignore', '.oasis/settings.json'], { cwd: root });
execFileSync('git', ['commit', '--quiet', '-m', 'Browser E2E workspace baseline'], { cwd: root });
const token = 'oasis-browser-e2e-token-0123456789';
const screenshotDir = process.env.OASIS_SCREENSHOT_DIR || path.join(process.cwd(), 'artifacts', 'browser-e2e');
await mkdir(screenshotDir, { recursive: true });

async function assertAgentContrast(page, label, selector = '#view-agent') {
  // Measure the settled UI, not a frame mid fade-in: wait for finite animations
  // and transitions (infinite pulses are skipped) before sampling colors.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations()
      .filter((animation) => { const timing = animation.effect && animation.effect.getComputedTiming(); return animation.playState === 'running' && timing && Number.isFinite(timing.endTime); })
      .map((animation) => animation.finished.catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]));
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');
  const other = results.violations.filter((violation) => violation.id !== 'color-contrast');
  if (other.length) {
    const details = other.map((violation) => violation.id + ' (' + violation.impact + '): ' +
      violation.nodes.map((node) => node.target.join(', ') + ' — ' + String(node.failureSummary || violation.help).replace(/\\s+/g, ' ').slice(0, 220)).join(' | ')).join(' || ');
    console.warn('[axe] ' + label + ': other accessibility findings: ' + details);
  }
  const detail = contrast.map((violation) =>
    violation.nodes.map((node) => violation.id + ' ' + node.target.join(', ') + ': ' +
      String(node.failureSummary || violation.help).replace(/\\s+/g, ' ').slice(0, 280)).join('\\n')
  ).join('\\n');
  assert.equal(contrast.length, 0, '[axe] ' + label + ' has color-contrast violations:\\n' + detail);
  console.log('[axe] ' + label + ': no color-contrast violations (' + results.passes.length + ' passing rules).');
}

const frameMetrics = [];
async function measureFrames(page, label, action) {
  await page.evaluate(() => {
    const probe = { active: true, last: performance.now(), samples: [] };
    window.__oasisFrameProbe = probe;
    const tick = (now) => {
      if (!probe.active) return;
      probe.samples.push(now - probe.last);
      probe.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  await page.waitForTimeout(180);
  const result = await page.evaluate(() => {
    const probe = window.__oasisFrameProbe;
    if (!probe) return { frames: 0, worstFrameMs: 0, over50ms: 0, near16ms: 0 };
    probe.active = false;
    const frames = probe.samples;
    return {
      frames: frames.length,
      worstFrameMs: Number(Math.max(0, ...frames).toFixed(1)),
      over50ms: frames.filter((value) => value > 50).length,
      near16ms: frames.filter((value) => value >= 12 && value <= 22).length
    };
  });
  const record = { interaction: label, ...result };
  frameMetrics.push(record);
  console.log('[frames 4x CPU] ' + label + ': worst ' + result.worstFrameMs +
    'ms; ' + result.frames + ' frames; ' + result.over50ms + ' over 50ms; ' + result.near16ms + ' near 16ms.');
  return record;
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

    // Exercise the visible activity story: create, read, edit, approve
    // a protected edit, approve a failing command, review the diff, and run
    // a focused content check. The final answer must satisfy the real
    // post-edit verification gate rather than bypass it.
    let assistantMessage;
    let finishReason = 'tool_calls';
    if (completionCalls === 1) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_write', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({
          path: 'browser-e2e-output.txt',
          content: 'Created by the authenticated browser agent tool cycle.\n'
        }) }
      }] };
    } else if (completionCalls === 2) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_read', type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'browser-e2e-output.txt', token: 'super-secret-value' }) }
      }] };
    } else if (completionCalls === 3) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_edit', type: 'function',
        function: { name: 'edit_file', arguments: JSON.stringify({
          path: 'browser-e2e-output.txt',
          old_string: 'Created by the authenticated browser agent tool cycle.',
          new_string: 'Edited by the authenticated browser agent tool cycle.'
        }) }
      }] };
    } else if (completionCalls === 4) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_protected_edit', type: 'function',
        function: { name: 'edit_file', arguments: JSON.stringify({
          path: '.oasis/settings.json',
          old_string: '"theme":"dark"',
          new_string: '"theme":"light"'
        }) }
      }] };
    } else if (completionCalls === 5) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_failing_command', type: 'function',
        function: { name: 'run_command', arguments: JSON.stringify({
          command: 'node', args: ['-e', 'process.exit(7)']
        }) }
      }] };
    } else if (completionCalls === 6) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_test_write', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({
          path: 'browser-e2e-verification.test.mjs',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { readFile } from 'node:fs/promises';",
            "",
            "test('the edited browser fixture content is correct', async () => {",
            "  const content = await readFile('browser-e2e-output.txt', 'utf8');",
            "  assert.equal(content, 'Edited by the authenticated browser agent tool cycle.\\n');",
            "});",
            ""
          ].join('\n')
        }) }
      }] };
    } else if (completionCalls === 7) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_diff', type: 'function',
        function: { name: 'git_diff', arguments: JSON.stringify({ scope: 'all' }) }
      }] };
    } else if (completionCalls === 8) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_content_check', type: 'function',
        function: { name: 'run_command', arguments: JSON.stringify({
          command: 'node',
          args: ['--test', 'browser-e2e-verification.test.mjs']
        }) }
      }] };
    } else if (completionCalls === 9) {
      finishReason = 'stop';
      assistantMessage = { role: 'assistant', content: 'A focused Node test passed for the edited file. The separate negative-command scenario remained an intentional approval and activity-visibility check.' };
    } else if (completionCalls === 10) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_delete', type: 'function',
        function: { name: 'delete_file', arguments: JSON.stringify({ path: 'browser-e2e-output.txt' }) }
      }] };
    } else if (completionCalls === 11) {
      finishReason = 'stop';
      assistantMessage = { role: 'assistant', content: 'The delete request was denied; the file remains unchanged.' };
    } else if (completionCalls === 12) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_cancel', type: 'function',
        function: { name: 'run_command', arguments: JSON.stringify({
          command: 'node',
          args: ['-e', 'require("node:fs").writeFileSync("cancel-e2e-side-effect.txt", "ran")']
        }) }
      }] };
    } else if (completionCalls === 13) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_worktree_write', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({
          path: 'review-e2e-output.txt',
          content: 'Created in the isolated worktree for diff review.\n'
        }) }
      }] };
    } else if (completionCalls === 14) {
      assistantMessage = { role: 'assistant', content: null, tool_calls: [{
        id: 'call_browser_e2e_worktree_read', type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'review-e2e-output.txt' }) }
      }] };
    } else if (completionCalls === 15) {
      finishReason = 'stop';
      assistantMessage = { role: 'assistant', content: 'Isolated worktree fixture completed successfully. I read back the new file and the review branch is ready.' };
    } else {
      finishReason = 'stop';
      assistantMessage = { role: 'assistant', content: 'Unexpected extra browser E2E model request.' };
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
  // Scripted speech recognition so dictation can be checked without a microphone.
  await context.addInitScript(() => {
    const Fake = class { start() { window.__oasisE2eRecognition = this; } stop() { if (this.onend) this.onend(); } };
    window.SpeechRecognition = Fake;
    window.webkitSpeechRecognition = Fake;
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    // The rejected-token step intentionally produces one 401 network log; app errors still fail the run.
    if (message.type() === 'error' && !/Failed to load resource: .*401/.test(message.text())) consoleErrors.push(message.text());
  });

  await page.goto('http://127.0.0.1:' + app.port + '/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForFunction(() => document.querySelector('#agentWorkspaceGrid')?.dataset.terminalVisible === 'false',
    null, { timeout: timeoutMs });
  assert.equal(await page.locator('#view-agent').evaluate((node) => node.classList.contains('active')), true,
    'The workspace should open on the coding conversation.');

  // llama-server prompt-reading progress: shown in the live status, advanced between reports, cleared on the reply.
  const promptReading = await page.evaluate(async () => {
    let setBusy = null;
    window.oasisCore.hook('agentSetBusy', (current) => { setBusy = current; return current; });
    setBusy(true);
    const span = document.querySelector('.agent-typing span');
    window.oasisCore.processEvent('e2e-progress', { type: 'model_wait', data: { phase: 'progress', step: 1, promptProgress: { total: 3725, cache: 0, processed: 2048, time_ms: 79165 } } });
    const first = span.textContent;
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const later = span.textContent;
    window.oasisCore.processEvent('e2e-progress', { type: 'assistant_delta', data: { text: '' } });
    const cleared = span.textContent;
    setBusy(false);
    return { first, later, cleared };
  });
  assert.match(promptReading.first, /^Local model is reading the prompt · 54% of 3\.7k tokens · about 1m 0\ds left$/);
  assert.match(promptReading.later, /· 5[5-9]% of 3\.7k tokens/);
  assert.equal(promptReading.cleared, 'Working…');

  // Dictation: interim words show in place, final words are kept, typed text is preserved.
  const dictation = await page.evaluate(() => {
    const button = document.getElementById('agentDictateBtn');
    const input = document.getElementById('agentPrompt');
    const visible = !button.hidden;
    input.value = 'Fix the bug';
    button.click();
    const pressed = button.getAttribute('aria-pressed');
    const results = (items) => ({ resultIndex: 0, results: items.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
    window.__oasisE2eRecognition.onresult(results([['in the parser', false]]));
    const interim = input.value;
    window.__oasisE2eRecognition.onresult(results([['in the parser', true], [' and add a test', false]]));
    const mixed = input.value;
    button.click();
    const final = input.value;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { visible, pressed, interim, mixed, final, released: button.getAttribute('aria-pressed') };
  });
  assert.deepEqual(dictation, { visible: true, pressed: 'true', interim: 'Fix the bug in the parser', mixed: 'Fix the bug in the parser and add a test', final: 'Fix the bug in the parser', released: 'false' });
  await page.locator('.sidebar [data-nav="home"]').first().click();
  assert.equal(await page.locator('#view-home').evaluate((node) => node.classList.contains('active')), true,
    'The existing Overview page should remain available.');
  await page.locator('#sidebarSettingsButton').click();
  assert.equal(await page.locator('#view-settings').evaluate((node) => node.classList.contains('active')), true,
    'Legacy destinations and preferences should be grouped under Settings.');
  await page.locator('#view-settings [data-nav="projects"]').click();
  assert.equal(await page.locator('#view-projects').evaluate((node) => node.classList.contains('active')), true,
    'The Settings page should preserve the existing Projects view.');
  await page.locator('#sidebarProjectPickerBtn').click();
  assert.equal(await page.locator('#view-projects').evaluate((node) => node.classList.contains('active')), true,
    'The project picker should open the existing project list.');
  await page.locator('#sidebarNewChatBtn').click();
  assert.equal(await page.locator('#view-agent').evaluate((node) => node.classList.contains('active')), true,
    'New chat should open the coding conversation.');

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
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'false',
    'The utility rail should be closed by default.');
  await assertAgentContrast(page, 'Agent empty state · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-empty-desktop.png'), fullPage: true });
  // The starter cards belong to the empty-state UI, so test them before connecting.
  await page.locator('[data-agent-example="Explain this project"]').click();
  assert.match(await page.locator('#agentPrompt').inputValue(), /^Explain this project/, 'Starter prompt cards should fill the chat composer.');

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
  await page.locator('#topbarProjectName').waitFor({ state: 'visible', timeout: timeoutMs });
  // Images can be attached from the composer; each shows a removable thumbnail.
  const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  await page.locator('#agentAttachInput').setInputFiles([{ name: 'screenshot.png', mimeType: 'image/png', buffer: tinyPng }]);
  await page.locator('#agentAttachments .agent-attachment').first().waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#agentAttachments .agent-attachment').count(), 1);
  assert.equal(await page.locator('#agentPrompt').evaluate((node) => node.required), false, 'An attached image alone should be sendable.');
  await assertAgentContrast(page, 'Agent image attachment · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-attachment-desktop.png'), fullPage: true });
  await page.locator('#agentAttachments .agent-attachment-remove').click();
  assert.equal(await page.locator('#agentAttachments .agent-attachment').count(), 0);
  assert.equal(await page.locator('#agentAttachments').isHidden(), true);
  await assertAgentContrast(page, 'Agent workspace · desktop');
  await page.locator('#agentModelButton').click();
  // The model pill brings provider settings into view (it may already be visible).
  await page.waitForFunction(() => {
    const target = document.querySelector('.provider-setup') || document.getElementById('provider-setup');
    if (!target) return false;
    const box = target.getBoundingClientRect();
    return box.top < window.innerHeight && box.bottom > 0;
  }, null, { timeout: timeoutMs });
  await assertAgentContrast(page, 'Agent provider settings · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-provider-settings-desktop.png'), fullPage: true });
  const perfCdp = await context.newCDPSession(page);
  await perfCdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // Preserve a turn-level trace so a missing activity summary is diagnosable
  // from CI artifacts rather than only appearing as a generic visibility timeout.
  await page.evaluate(() => {
    const trace = window.__oasisE2EActivityTrace = [];
    const wrap = (name, before, after) => {
      const original = window[name];
      if (typeof original !== 'function') return;
      window[name] = function (...args) {
        if (before) trace.push(before(args));
        const result = original.apply(this, args);
        if (after) trace.push(after(args));
        return result;
      };
    };
    const state = () => ({
      busy: typeof window.oasisCore?.busy === 'boolean' ? window.oasisCore.busy : null,
      workStart: Number(window.workStart || 0),
      groupCount: Array.isArray(window.activityGroups) ? window.activityGroups.length : null,
      domGroups: document.querySelectorAll('#agentMessages .activity-group').length,
      domSteps: document.querySelectorAll('#agentMessages .activity-step').length,
      folded: document.querySelectorAll('#agentMessages .turn-work').length,
      preference: localStorage.getItem('oasis.web.collapseWork') || 'on'
    });
    wrap('oasisActivityStart', (args) => ({
      event: 'activity-start',
      callId: args[0]?.callId || '',
      category: args[0]?.category || '',
      label: args[0]?.label || '',
      before: state()
    }), () => ({ event: 'activity-start-return', after: state() }));
    wrap('oasisActivityResult', (args) => ({
      event: 'activity-result',
      callId: args[0]?.callId || '',
      status: args[0]?.status || '',
      label: args[0]?.label || '',
      before: state()
    }), () => ({ event: 'activity-result-return', after: state() }));
    wrap('agentSetBusy', (args) => ({ event: 'set-busy-before', value: !!args[0], state: state() }),
      (args) => ({ event: 'set-busy-after', value: !!args[0], state: state() }));
    for (const name of ['oasisBeginActivityTurn', 'oasisFinishActivityTurn']) {
      const original = window[name];
      if (typeof original !== 'function') continue;
      window[name] = function (...args) {
        const snapshot = () => typeof window.oasisActivityState === 'function' ? window.oasisActivityState() : null;
        trace.push({ event: name + '-before', state: snapshot() });
        const result = original.apply(this, args);
        trace.push({ event: name + '-after', result, state: snapshot() });
        return result;
      };
    }
  });
  await page.locator('#agentPrompt').fill('Run the browser end-to-end fixture and report its result.');
  await measureFrames(page, 'approval card opening', async () => {
    await page.locator('#agentSendBtn').click();
    await page.locator('#agentApprovalCard').waitFor({ state: 'visible', timeout: timeoutMs });
  });
  await assertAgentContrast(page, 'Agent edit approval card');
  const editApprovalDiff = await page.locator('#agentApprovalDiff').innerText();
  assert.match(editApprovalDiff, /-"theme":"dark"/);
  assert.match(editApprovalDiff, /\+"theme":"light"/);
  await page.screenshot({ path: path.join(screenshotDir, 'agent-edit-approval-desktop.png'), fullPage: true });
  const editApprovalPrompt = await page.locator('#agentApprovalPrompt').innerText();
  await approveAndWaitForNextApproval(page, editApprovalPrompt);
  const commandApproval = await page.locator('#agentApprovalPrompt').innerText();
  assert.match(commandApproval, /node -e "process\.exit\(7\)"/);
  assert.equal(await page.locator('#agentApprovalDiff').isHidden(), true,
    'A command approval should not display a file-edit diff.');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-command-approval-desktop.png'), fullPage: true });
  await approveAndWaitForNextApproval(page, commandApproval);
  const contentCheckApproval = await page.locator('#agentApprovalPrompt').innerText();
  assert.match(contentCheckApproval, /node "?--test"? "?browser-e2e-verification\.test\.mjs"?/);
  await page.screenshot({ path: path.join(screenshotDir, 'agent-content-check-approval-desktop.png'), fullPage: true });
  await page.locator('#agentApproveBtn').click();
  await page.locator('#agentApprovalCard').waitFor({ state: 'hidden', timeout: timeoutMs });
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('#agentMessages .agent-message.assistant')]
      .some((element) => element.textContent.includes('A focused Node test passed for the edited file.')),
    null, { timeout: timeoutMs });
  } catch (error) {
    const messages = await page.locator('#agentMessages').innerText().catch(() => '[messages unavailable]');
    throw new Error(String(error && error.message || error) +
      '; fixture provider calls=' + completionCalls +
      '; runtime state=' + await page.locator('#agentRuntimeState').innerText().catch(() => '[state unavailable]') +
      '; chat messages=' + JSON.stringify(messages) +
      '; page errors=' + JSON.stringify(pageErrors));
  }

  try {
    await page.waitForFunction(() => window.oasisCore?.busy === false &&
      typeof window.oasisActivityState === 'function' && window.oasisActivityState().active === false,
    null, { timeout: timeoutMs });
  } catch (error) {
    const state = await page.evaluate(() => ({
      busy: window.oasisCore?.busy ?? null,
      activity: typeof window.oasisActivityState === 'function' ? window.oasisActivityState() : null,
      runtime: document.querySelector('#agentRuntimeState')?.textContent || '',
      approvalVisible: !document.querySelector('#agentApprovalCard')?.hidden,
      groups: [...document.querySelectorAll('#agentMessages .activity-group')].map((node) => ({
        category: node.dataset.category || '',
        parent: node.parentElement?.id || node.parentElement?.className || '',
        steps: node.querySelectorAll('.activity-step').length
      })),
      trace: window.__oasisE2EActivityTrace || [],
      messages: document.querySelector('#agentMessages')?.innerText.slice(-3500) || ''
    }));
    await page.screenshot({ path: path.join(screenshotDir, 'agent-activity-lifecycle-debug.png'), fullPage: true });
    throw new Error(String(error && error.message || error) +
      '; provider calls=' + completionCalls + '; terminal lifecycle=' + JSON.stringify(state));
  }
  const activitySummary = page.locator('#agentMessages .turn-work');
  try {
    await activitySummary.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    const activityDebug = await page.evaluate(() => ({
      preference: localStorage.getItem('oasis.web.collapseWork') || 'on',
      runtimeBusy: window.oasisCore?.busy ?? null,
      activityState: typeof window.oasisActivityState === 'function' ? window.oasisActivityState() : null,
      groups: [...document.querySelectorAll('#agentMessages .activity-group')].map((node) => ({
        category: node.dataset.category || '',
        parent: node.parentElement?.id || node.parentElement?.className || '',
        steps: node.querySelectorAll('.activity-step').length,
        text: node.innerText.slice(0, 300)
      })),
      activitySteps: document.querySelectorAll('#agentMessages .activity-step').length,
      foldedSummaries: document.querySelectorAll('#agentMessages .turn-work').length,
      messages: document.querySelector('#agentMessages')?.innerText.slice(-5000) || '',
      trace: window.__oasisE2EActivityTrace || []
    }));
    await page.screenshot({ path: path.join(screenshotDir, 'agent-activity-debug-desktop.png'), fullPage: true });
    throw new Error(String(error && error.message || error) +
      '; activity debug=' + JSON.stringify(activityDebug));
  }
  const defaultActivityText = await page.locator('#agentMessages').innerText();
  assert.match(defaultActivityText, /The command failed|failed \(exit code 7\)|exit code 7/i,
    'The failed command warning must remain visible outside the fold.');
  assert.equal(await page.locator('#agentMessages .notice-warn').count() > 0, true,
    'A failed command must use the visible warning treatment.');
  assert.equal(await activitySummary.locator('.notice-warn').count(), 0,
    'The warning must not be hidden inside the Worked for disclosure.');
  assert.doesNotMatch(defaultActivityText, /Tool: (?:read_file|edit_file|run_command)|"path"\s*:/,
    'The default chat view must not expose raw tool names or JSON arguments.');
  assert.match(await activitySummary.locator(':scope > summary').innerText(), /Worked for .* · 8 tool calls/);
  await page.screenshot({ path: path.join(screenshotDir, 'agent-chat-desktop.png'), fullPage: true });

  await measureFrames(page, 'opening Worked for activity fold', async () => {
    await activitySummary.locator(':scope > summary').click();
  });
  const groups = page.locator('#agentMessages .turn-work .activity-group');
  assert.equal(await groups.count(), 7, 'File creation, reading, editing, the commands, test creation, and diff review should form readable groups.');
  const groupText = await activitySummary.innerText();
  assert.match(groupText, /Wrote 1 file/);
  assert.match(groupText, /Read 1 file/);
  assert.match(groupText, /Edited 2 files/);
  assert.equal((groupText.match(/Ran 1 command/g) || []).length, 2,
    'The intentionally failing command and successful Node test should remain separate, visible activity groups.');
  assert.match(groupText, /Reviewed changes/);
  assert.doesNotMatch(groupText, /Tool: (?:read_file|edit_file|run_command)|"path"\s*:/,
    'Raw tool detail should stay hidden until Show details is opened.');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-chat-activity-desktop.png'), fullPage: true });

  const readGroup = groups.filter({ hasText: 'Read 1 file' }).first();
  await readGroup.locator('.activity-group-fold > summary').click();
  const readDetails = readGroup.locator('.activity-tool-details');
  await readDetails.locator('summary').click();
  const readDetailText = await readDetails.innerText();
  assert.match(readDetailText, /Tool: read_file/);
  assert.match(readDetailText, /browser-e2e-output\.txt/);
  assert.doesNotMatch(readDetailText, /super-secret-value/,
    'Secrets must remain masked in the expanded details view.');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-chat-activity-details-desktop.png'), fullPage: true });

  await page.evaluate(() => {
    window.oasisCore.processEvent('context-ui-fixture', { type: 'compaction_started', data: { messages: 18, timeoutSeconds: 90 } });
    window.oasisCore.processEvent('context-ui-fixture', { type: 'compaction_completed', data: { savedTokens: 1800, notesSaved: true } });
    window.oasisCore.processEvent('context-ui-fixture', { type: 'context_overflow', data: { attempt: 1, changed: true } });
    window.oasisCore.processEvent('context-ui-fixture', { type: 'context_pruned', data: { pruned: 2, before: 2200, after: 900 } });
    window.oasisCore.processEvent('context-ui-fixture', { type: 'session_state', data: { contextPercent: 73, contextTokens: 73000, contextWindow: 100000, totalTokens: 84000, model: 'fixture' } });
  });
  const contextNotices = page.locator('#agentMessages .agent-context-notice');
  assert.equal(await contextNotices.count(), 4, 'Context lifecycle changes should be explained in the chat.');
  assert.match(await contextNotices.nth(0).innerText(), /Protecting conversation context/);
  assert.match(await contextNotices.nth(1).innerText(), /continuity note was saved/i);
  assert.match(await contextNotices.nth(2).innerText(), /retrying your original request/i);
  assert.match(await contextNotices.nth(3).innerText(), /Recent work was kept/i);
  assert.equal(await contextNotices.nth(2).getAttribute('role'), 'alert');
  assert.match(await page.locator('#agentContextMeter').innerText(), /Context ~73%/);
  assert.match(await page.locator('#agentContextMeter').getAttribute('title'), /estimate/i);
  await page.screenshot({ path: path.join(screenshotDir, 'agent-context-feedback-desktop.png'), fullPage: true });

  await measureFrames(page, 'streaming a long assistant reply', async () => {
    await page.evaluate(async () => {
      const id = 'oasis-frame-stream-fixture';
      const node = window.oasisCore.appendMessage('assistant', '', id);
      window.oasisCore.nodes[id] = node;
      const chunk = 'A streamed sentence is appended without rebuilding the message. ';
      for (let index = 0; index < 48; index++) {
        window.oasisCore.appendAssistantDelta(id, chunk);
        if (index % 4 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      // Replies render as Markdown while streaming, so compare the raw stream
      // exactly and the rendered text with whitespace normalized.
      await new Promise((resolve) => setTimeout(resolve, 1200)); // let the throttled render settle
      const expected = chunk.repeat(48);
      const raw = node.dataset.raw != null ? node.dataset.raw : node.textContent;
      const view = node.cloneNode(true);
      view.querySelectorAll('button').forEach((button) => button.remove());
      const shown = view.textContent.replace(/\s+/g, ' ').trim();
      if (raw !== expected || shown !== expected.trim()) throw new Error('Streaming did not preserve every assistant text chunk. raw=' + raw.length + '/' + expected.length + ' shown=' + shown.length + ' head=' + JSON.stringify(shown.slice(0, 80)) + ' tail=' + JSON.stringify(shown.slice(-80)));
      node.remove();
      delete window.oasisCore.nodes[id];
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390,
    'The activity groups and approval details must fit a 390px phone viewport.');
  await assertAgentContrast(page, 'Agent activity · 390px');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-chat-activity-390px.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  await measureFrames(page, 'switching between saved chats', async () => {
    await page.locator('#newAgentSessionBtn').click();
    await page.locator('#sidebarChatList [data-sidebar-session-id]').first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('#agentMessages .agent-message.user')]
      .some((element) => element.textContent.includes('Run the browser end-to-end fixture and report its result.')),
    null, { timeout: timeoutMs });
  });
  await perfCdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const worstFrame = Math.max(0, ...frameMetrics.map((item) => item.worstFrameMs));
  await writeFile(path.join(screenshotDir, 'frame-timings.json'), JSON.stringify({
    cpuThrottleRate: 4,
    interactions: frameMetrics,
    worstFrameMs: Number(worstFrame.toFixed(1)),
    targetWorstFrameMs: 50,
    metTarget: frameMetrics.every((item) => item.worstFrameMs <= 50)
  }, null, 2));
  console.log('[frames 4x CPU] worst measured frame: ' + worstFrame.toFixed(1) + 'ms across ' + frameMetrics.length + ' interactions.');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-chat-activity-desktop-after-switch.png'), fullPage: true });
  const response = await page.locator('#agentMessages .agent-message.assistant').allTextContents();
  assert.ok(response.some((text) => text.includes('A focused Node test passed for the edited file.')),
    'The fixture model response should be rendered in the actual agent chat UI.');
  assert.equal(completionCalls, 9, 'The agent should create, read, edit, create a verification test, review the diff, pass the test, approve three consequential actions, and report the results.');
  await page.waitForFunction(() => document.querySelectorAll('#sidebarChatList [data-sidebar-session-id]').length > 0,
    null, { timeout: timeoutMs });
  assert.ok(await page.locator('#sidebarChatList [data-sidebar-session-id]').count() > 0,
    'The sidebar should show saved conversations from the authenticated runtime.');
  assert.equal(
    await readFile(path.join(root, 'browser-e2e-output.txt'), 'utf8'),
    'Edited by the authenticated browser agent tool cycle.\n',
    'The browser request should result in a real workspace edit after the initial write and read.'
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
  assert.equal(completionCalls, 11, 'The denial should be reported to the model without running the delete operation.');
  assert.equal(
    await readFile(path.join(root, 'browser-e2e-output.txt'), 'utf8'),
    'Edited by the authenticated browser agent tool cycle.\n',
    'Denying the delete approval must leave the file intact.'
  );
  await page.waitForFunction(() => document.querySelector('#agentStopBtn')?.hidden === true, null, { timeout: timeoutMs });

  // "!command" in the chat runs through the approval-gated terminal job, shows its
  // output in the conversation, and is queued as context for the next message.
  await page.locator('#agentPrompt').fill('!node -e "console.log(\'shell-pass-ok\')"');
  await page.locator('#agentSendBtn').click();
  await page.locator('#agentApprovalCard').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('#agentApproveBtn').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#agentMessages .agent-message.shell')]
    .some((element) => element.textContent.split('\n').includes('shell-pass-ok')), null, { timeout: timeoutMs });
  assert.equal(completionCalls, 11, 'A ! shell command must not call the model.');
  const pendingShell = await page.evaluate(() => window.oasisTakePendingShell().map((entry) => entry.code + ':' + entry.output.trim()));
  assert.deepEqual(pendingShell, ['0:shell-pass-ok'], 'The shell output should be queued for the next message.');
  await page.waitForFunction(() => document.querySelector('#agentStopBtn')?.hidden === true, null, { timeout: timeoutMs });

  // Top-bar buttons open/close the three dedicated utility views.
  await page.locator('#topbarTasksBtn').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'true',
    'The top-bar Tasks button should open the side panel.');
  assert.equal(await page.locator('#topbarTasksBtn').getAttribute('aria-pressed'), 'true');
  await page.locator('#agentTasksUtilityPanel').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#agentTerminalUtilityPanel').isVisible(), false,
    'The Terminal panel should hide while Tasks is selected.');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#agentChangesUtilityTab').getAttribute('aria-selected'), 'true',
    'Left arrow from Tasks should select Changes.');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#agentTasksUtilityTab').getAttribute('aria-selected'), 'true',
    'Right arrow should return to Tasks.');
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#agentTerminalUtilityTab').getAttribute('aria-selected'), 'true',
    'Home should select Terminal.');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#agentTasksUtilityTab').getAttribute('aria-selected'), 'true',
    'End should select Tasks.');
  await assertAgentContrast(page, 'Tasks · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-tasks-desktop.png'), fullPage: true });
  await page.locator('#topbarChangesBtn').click();
  await page.locator('#agentChangesUtilityPanel').waitFor({ state: 'visible', timeout: timeoutMs });
  await assertAgentContrast(page, 'Changes · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-changes-desktop.png'), fullPage: true });
  await page.locator('#topbarChangesBtn').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'false',
    'Clicking the selected top-bar tab should close the side panel.');
  await page.locator('#topbarTerminalBtn').click();
  await page.locator('#agentTerminalUtilityPanel').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#topbarTerminalBtn').getAttribute('aria-pressed'), 'true');

  // Commit the output from the preceding non-isolated file test so the real
  // worktree run begins from a clean user workspace, as required in production.
  execFileSync('git', ['add', 'browser-e2e-output.txt', 'browser-e2e-verification.test.mjs', '.oasis/settings.json'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'Commit browser chat fixture output'], { cwd: root });
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '',
    'The primary checkout must be clean before creating an isolated worktree.');

  // Saved-chat recovery must reopen the parent chat without restarting workers.
  await page.locator('#sidebarSettingsButton').click();
  await page.locator('#view-settings [data-nav="monitor"]').click();
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
      assistants.some((element) => element.textContent.includes('A focused Node test passed for the edited file.'));
  }, null, { timeout: timeoutMs });
  console.log('PASS saved-chat recovery: the monitor reopened the saved parent conversation without restarting a worker.');

  // A running task can be stopped while it is blocked at a command approval.
  await page.locator('#agentPrompt').fill('Run the cancellation fixture command after getting my approval.');
  await page.locator('#agentSendBtn').click();
  await page.locator('#agentApprovalCard').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#agentStopBtn').isEnabled(), true, 'Stop should be enabled while command approval is pending.');
  await page.locator('#agentStopBtn').click();
  await page.waitForFunction(() => /cancelled/i.test(document.querySelector('#agentRuntimeState')?.textContent || ''), null, { timeout: timeoutMs });
  assert.equal(completionCalls, 12, 'Cancellation must abort the task before another model request.');
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
  assert.equal(completionCalls, 15, 'The isolated task should write the file, read it back for verification, and then finish.');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), mainHeadBeforeWorktree,
    'Finishing isolated work must not advance the primary branch.');
  assert.ok(execFileSync('git', ['branch', '--list', 'oasis/*'], { cwd: root, encoding: 'utf8' }).trim(),
    'The isolated change must remain on a separate review branch.');
  await assert.rejects(readFile(path.join(root, 'review-e2e-output.txt')), { code: 'ENOENT' });

  // Hiding the entire utility rail must not strand the monitor's review shortcut.
  await page.locator('#agentTerminalToggle').click();
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'false');
  await page.locator('#sidebarSettingsButton').click();
  await page.locator('#view-settings [data-nav="monitor"]').click();
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
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-terminal-visible'), 'true',
    'Reviewing a run must reveal the utility rail even when it was hidden.');
  assert.equal(await page.locator('#agentChangesUtilityTab').getAttribute('aria-selected'), 'true',
    'Reviewing a run must select Changes.');
  await assertAgentContrast(page, 'Changes diff · desktop');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-isolated-diff-desktop.png'), fullPage: true });
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), mainHeadBeforeWorktree,
    'Opening the isolated diff must not merge the worktree or change the main branch.');
  await page.locator('#cloudRunDiffClose').click();
  await page.locator('#cloudRunDetailClose').click();
  console.log('PASS isolated-diff review: Run Monitor opened the committed branch diff and left the main checkout untouched.');

  assert.deepEqual(pageErrors, [], 'The browser page must not throw JavaScript errors.');
  assert.deepEqual(consoleErrors, [], 'The browser page must not log console errors.');
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
  assert.equal(await page.locator('#agentWorkspaceGrid').getAttribute('data-active-panel'), 'terminal',
    'The phone Tools tab should open the terminal, changes and tasks pane.');
  await assertAgentContrast(page, 'Agent terminal panel · 390px');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-terminal-390px.png'), fullPage: true });
  await page.locator('#agentTasksUtilityTab').click();
  await page.locator('#agentTasksUtilityPanel').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await page.locator('#agentTerminalUtilityPanel').isVisible(), false);
  await assertAgentContrast(page, 'Tasks · 390px');
  const utilityMobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(utilityMobileWidth <= 390, 'Tasks must not overflow horizontally at 390px.');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-tasks-390px.png'), fullPage: true });
  await page.locator('#agentChangesUtilityTab').click();
  await page.locator('#agentChangesUtilityPanel').waitFor({ state: 'visible', timeout: timeoutMs });
  await assertAgentContrast(page, 'Changes · 390px');
  await page.screenshot({ path: path.join(screenshotDir, 'agent-changes-390px.png'), fullPage: true });
  await page.locator('#agentTerminalUtilityTab').click();
  assert.equal(await page.locator('#agentTerminalUtilityPanel').isVisible(), true);
  await page.locator('#sidebarMenuButton').click();
  assert.equal(await page.locator('#sidebarMenuButton').getAttribute('aria-expanded'), 'true',
    'The phone menu should open the saved-chats drawer.');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sidebarMenuButton').getAttribute('aria-expanded'), 'false',
    'Escape should close the saved-chats drawer.');
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
    token: 'oasis-first-run-e2e-token-0123456789',
    // Deterministic stand-ins for the desktop updater and hardware probe, so the
    // update banner and the "Recommended for this computer" card render in CI.
    appUpdate: (() => {
      const state = { phase: 'available', available: true, current: '1.0.0', latest: { version: '9.9.9', url: 'https://github.com/FAHTHIZ/oasis/releases/tag/v9.9.9' }, canInstall: true, checkedAt: Date.now() };
      return { status: () => state, check: async () => state, skip: async () => ({ skipped: true }), prompt: async () => {} };
    })(),
    profileComputer: async () => ({
      hardware: { os: 'darwin', platform: 'darwin', arch: 'arm64', cores: 12, memoryGB: 36, appleSilicon: true, gpu: null },
      budgetGB: 24,
      primary: { route: 'local-install', model: 'qwen3:14b', serverName: 'Ollama', reason: 'With 36 GB of unified memory, Qwen3 14B runs comfortably on this Mac.', install: { command: 'ollama pull qwen3:14b', url: 'https://ollama.com/download' } },
      alternatives: [], notes: []
    })
  });
  try {
    const firstRunPage = await context.newPage();
    const firstRunErrors = [];
    const firstRunConsoleErrors = [];
    firstRunPage.on('pageerror', (error) => firstRunErrors.push(error.message));
    firstRunPage.on('console', (message) => {
      if (message.type() === 'error') firstRunConsoleErrors.push(message.text());
    });
    await firstRunPage.setViewportSize({ width: 1280, height: 900 });
    await firstRunPage.goto('http://127.0.0.1:' + firstRunApp.port + '/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await firstRunPage.locator('#sidebarNewChatBtn').click();
    await firstRunPage.locator('#agentTokenInput').fill(firstRunApp.token);
    await firstRunPage.locator('#agentConnectBtn').click();
    await firstRunPage.locator('#firstRunWizard').waitFor({ state: 'visible', timeout: timeoutMs });
    await firstRunPage.locator('#firstRunRecommend').waitFor({ state: 'visible', timeout: timeoutMs });
    assert.match(await firstRunPage.locator('#firstRunRecommendTitle').innerText(), /qwen3:14b/);
    assert.equal(await firstRunPage.locator('#firstRunRecommendUse').innerText(), 'Get Ollama');
    assert.doesNotMatch(await firstRunPage.locator('#firstRunRecommend').innerText(), /undefined|null/);
    await firstRunPage.locator('#updateBanner').waitFor({ state: 'visible', timeout: timeoutMs });
    assert.match(await firstRunPage.locator('#updateBannerTitle').innerText(), /9\.9\.9 is available/);
    assert.equal(await firstRunPage.locator('#updateBannerInstall').innerText(), 'Install and restart');
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-recommendation-update-desktop.png'), fullPage: false });
    await assertAgentContrast(firstRunPage, 'update banner', '#updateBanner');
    await firstRunPage.locator('#updateBannerLater').click();
    assert.equal(await firstRunPage.locator('#updateBanner').isHidden(), true, 'Later must hide the update banner.');
    // Connect a phone: the dialog opens with both network choices and passes the contrast scan.
    await firstRunPage.evaluate(() => window.oasisConnectPhone());
    await firstRunPage.locator('#phoneDialog').waitFor({ state: 'visible', timeout: timeoutMs });
    await firstRunPage.locator('#phoneTailscaleBtn').waitFor({ state: 'visible', timeout: timeoutMs });
    await firstRunPage.waitForFunction(() => !/Checking/.test(document.getElementById('phoneDialogHint').textContent), null, { timeout: timeoutMs });
    assert.match(await firstRunPage.locator('#phoneLanBtn').innerText(), /unencrypted/);
    await assertAgentContrast(firstRunPage, 'connect a phone dialog', '#phoneDialog');
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'connect-a-phone-desktop.png'), fullPage: false });
    await firstRunPage.locator('#phoneCloseBtn').click();
    await firstRunPage.locator('#phoneDialog').waitFor({ state: 'hidden', timeout: timeoutMs });
    await assertAgentContrast(firstRunPage, 'First-run setup · desktop');
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-desktop.png'), fullPage: true });

    await firstRunPage.locator('[data-first-run="api"]').click();
    assert.equal(await firstRunPage.locator('#providerPreset').inputValue(), 'openai');
    assert.equal(await firstRunPage.locator('[data-first-run="api"]').getAttribute('aria-pressed'), 'true');
    assert.match(await firstRunPage.locator('#firstRunStatus').innerText(), /API route selected/i);
    await assertAgentContrast(firstRunPage, 'First-run API route · desktop');
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-api-route-desktop.png'), fullPage: true });

    await firstRunPage.locator('[data-first-run="omniroute"]').click();
    assert.equal(await firstRunPage.locator('#providerPreset').inputValue(), 'omniroute');
    assert.equal(await firstRunPage.locator('[data-first-run="omniroute"]').getAttribute('aria-pressed'), 'true');
    assert.match(await firstRunPage.locator('#firstRunStatus').innerText(), /OmniRoute must be running/i);
    await assertAgentContrast(firstRunPage, 'First-run gateway route · desktop');
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-gateway-route-desktop.png'), fullPage: true });

    await firstRunPage.locator('[data-first-run="ollama"]').click();
    assert.equal(await firstRunPage.locator('#providerPreset').inputValue(), 'ollama');
    assert.equal(await firstRunPage.locator('[data-first-run="ollama"]').getAttribute('aria-pressed'), 'true');
    await assertAgentContrast(firstRunPage, 'First-run local route · desktop');
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-local-route-desktop.png'), fullPage: true });

    await firstRunPage.setViewportSize({ width: 390, height: 844 });
    const firstRunMobileWidth = await firstRunPage.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(firstRunMobileWidth <= 390, 'The first-run screen must not overflow horizontally at 390px.');
    await assertAgentContrast(firstRunPage, 'First-run setup · 390px');
    assert.equal(await firstRunPage.locator('[data-first-run="ollama"]').getAttribute('aria-pressed'), 'true', 'The selected route should remain visible on phone.');
    await firstRunPage.screenshot({ path: path.join(screenshotDir, 'first-run-390px.png'), fullPage: true });
    assert.equal(await firstRunPage.locator('[data-first-run]').count(), 3, 'First run should present all three model choices.');
    assert.deepEqual(firstRunErrors, [], 'The first-run screen must not throw JavaScript errors.');
    assert.deepEqual(firstRunConsoleErrors, [], 'The first-run screen must not log console errors.');
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
    const closed = new Promise((resolve) => providerServer.close(resolve));
    // Keep-alive sockets from the agent's provider client would otherwise hold close() open.
    providerServer.closeAllConnections?.();
    await closed;
  }
  // The final cloud-task event can finish writing just after browser shutdown.
  // Retry transient ENOTEMPTY/EBUSY races rather than marking a clean E2E run failed.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

// Consecutive approvals can reuse the visible card without hiding it in between,
// so a visibility wait alone can read the prompt that was just approved. Wait for
// the prompt text itself to change instead.
async function approveAndWaitForNextApproval(page, previousPrompt) {
  await page.locator('#agentApproveBtn').click();
  await page.waitForFunction((previous) => {
    const card = document.querySelector('#agentApprovalCard');
    const prompt = document.querySelector('#agentApprovalPrompt');
    return Boolean(card && !card.hidden && card.offsetParent !== null && prompt && prompt.innerText !== previous);
  }, previousPrompt, { timeout: timeoutMs });
}
