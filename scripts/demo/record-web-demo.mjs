#!/usr/bin/env node
// Records the README Web UI demo.
//
// What is real: the OASIS web server, the browser workspace, tools, approval
// cards, steering, the project's test run and the Changes panel. What is
// scripted: the model. A tiny local OpenAI-compatible server replays fixed
// replies (below), so the recording is reproducible and needs no API key.
//
//   node scripts/demo/record-web-demo.mjs [out-dir]
//
// Needs Playwright with Chromium (`npm i --no-save playwright && npx playwright
// install chromium`) and ffmpeg. Writes oasis-web-demo.{mp4,gif} and a poster.

import http from 'node:http';
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

process.env.TZ = 'Asia/Dhaka';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.resolve(process.argv[2] || path.join(ROOT, 'assets', 'demo'));
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Scripted model -------------------------------------------------------

const FIX_OLD = '  return new Date(task.due) < now;';
const FIX_NEW = '  return task.due < toDay(now);';
const TEST_OLD = "  assert.equal(daysUntil('2026-11-08', NOW), 7);\n});";
const TEST_NEW = TEST_OLD + "\n\ntest('a task due today is not overdue late in the day', () => {\n  const lateToday = new Date(2026, 10, 1, 23, 59);\n  assert.equal(isOverdue({ due: '2026-11-01', status: 'open' }, lateToday), false);\n});";

const STEPS = [
  { text: "I'll find where overdue is decided, fix the root cause, and add a regression test.", tool: ['grep', { pattern: 'isOverdue', path: 'src' }] },
  { tool: ['read_file', { path: 'src/dates.mjs' }], waitForSteer: true },
  { text: "Got it, I'll leave the CLI output format exactly as it is. The bug is in the comparison: `new Date('2026-11-01')` is **UTC** midnight, so east of UTC a task turns overdue hours before the local day ends. I'll compare calendar days instead.", tool: ['edit_file', { path: 'src/dates.mjs', old_string: FIX_OLD, new_string: FIX_NEW }] },
  { text: 'Now a regression test that fails on the old code.', tool: ['edit_file', { path: 'test/dates.test.mjs', old_string: TEST_OLD, new_string: TEST_NEW }] },
  { tool: ['run_command', { command: 'npm', args: ['test'] }] },
  { tool: ['git_diff', {}] },
  { text: '**Fixed.** `isOverdue` compared a UTC instant with local time; it now compares calendar days.\n\n| Check | Result |\n| --- | --- |\n| `npm test` | 20 passed, 0 failed |\n| Files changed | `src/dates.mjs` (1 line), `test/dates.test.mjs` (+4) |\n| CLI output | unchanged, as you asked |\n\nThe change is unstaged so you can review it in **Changes**.' }
];

let steerSent = false;
let callId = 0;

async function streamReply(res, step) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', model: 'demo-model', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
  if (step.text) {
    const words = step.text.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 2) { send({ content: words.slice(i, i + 2).join('') }); await sleep(34); }
  }
  if (step.tool) {
    callId += 1;
    send({ tool_calls: [{ index: 0, id: 'call_' + callId, type: 'function', function: { name: step.tool[0], arguments: JSON.stringify(step.tool[1]) } }] });
  }
  send({}, step.tool ? 'tool_calls' : 'stop');
  res.write('data: ' + JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 4200, completion_tokens: 120, total_tokens: 4320 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function startModel() {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'GET' && /\/models/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'demo-model', object: 'model', context_length: 131072 }] }));
    }
    let request = {};
    try { request = JSON.parse(body || '{}'); } catch {}
    const messages = Array.isArray(request.messages) ? request.messages : [];
    if (!Array.isArray(request.tools) || !request.tools.length) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Fix overdue check' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 4, total_tokens: 54 } }));
    }
    const replies = messages.filter((m) => m.role === 'assistant').length;
    const step = STEPS[Math.min(replies, STEPS.length - 1)];
    await sleep(replies === 0 ? 1800 : 700);
    // Hold this step until the recorder has sent its steering message, so the
    // next request carries it (the demo is deterministic, not racy).
    if (step.waitForSteer) { const end = Date.now() + 30000; while (!steerSent && Date.now() < end) await sleep(100); await sleep(400); }
    await streamReply(res, step);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- Demo project ----------------------------------------------------------

function makeProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oasis-web-demo-'));
  const project = path.join(dir, 'taskflow');
  cpSync(path.join(ROOT, 'evals', 'tasks', 'taskflow-overdue-today', 'repo'), project, { recursive: true });
  writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.com' } });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'taskflow');
  return { dir, project };
}

// ---- Recording ---------------------------------------------------------------

async function main() {
  const model = await startModel();
  const { dir, project } = makeProject();
  const configDir = path.join(dir, 'config');
  process.env.OASIS_CONFIG_DIR = configDir;
  process.env.OASIS_NO_UPDATE_CHECK = '1';
  const { saveConfig } = await import('../../src/config.mjs');
  const { startOasisWebServer } = await import('../../src/web.mjs');
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir };
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', model: 'demo-model', apiKey: '' }, { env });
  const token = 'oasis-web-demo-token-0123456789abcdef';
  const app = await startOasisWebServer({ root: project, host: '127.0.0.1', port: 0, env, token });

  const videoDir = path.join(dir, 'video');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark', serviceWorkers: 'block', recordVideo: { dir: videoDir, size: { width: W, height: H } } });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:' + app.port + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#agentTokenInput').fill(token);
  await page.locator('#agentConnectBtn').click();
  await page.waitForFunction(() => /connected/i.test(document.querySelector('#agentRuntimeState')?.textContent || '') && !/not connected|failed/i.test(document.querySelector('#agentRuntimeState')?.textContent || ''));
  await page.locator('#topbarProjectName').waitFor({ state: 'visible' });
  const introMs = Date.now() - t0;
  await sleep(1500);

  const promptBox = page.locator('#agentPrompt');
  await promptBox.click();
  await promptBox.pressSequentially('Tasks due today show as overdue late in the evening. Fix it and add a regression test.', { delay: 32 });
  await sleep(500);
  await page.locator('#agentSendBtn').click();

  // Steer while it works.
  await page.waitForFunction(() => /grep|search|isOverdue/i.test(document.querySelector('#agentMessages')?.innerText || ''), null, { timeout: 30000 });
  await sleep(900);
  await promptBox.click();
  await promptBox.pressSequentially('Keep the CLI output format unchanged.', { delay: 40 });
  await sleep(400);
  await promptBox.press('Enter');
  await page.waitForFunction(() => document.querySelector('.agent-steer'), null, { timeout: 10000 });
  steerSent = true;

  // Approve whatever the permission mode asks for until the final answer lands.
  const done = () => page.evaluate(() => /review it in/i.test(document.querySelector('#agentMessages')?.innerText || ''));
  const until = Date.now() + 120000;
  while (!(await done())) {
    if (Date.now() > until) { await page.screenshot({ path: '/tmp/web-demo-stuck.png' }); throw new Error('demo did not finish'); }
    if (await page.locator('#agentApprovalCard').isVisible()) {
      await sleep(1500);
      await page.locator('#agentApproveBtn').click();
      await sleep(400);
    }
    await sleep(150);
  }
  await sleep(2600);
  await page.locator('#topbarChangesBtn').click();
  await sleep(4500);
  await page.screenshot({ path: path.join(dir, 'poster.png') });
  await context.close();
  await browser.close();
  await app.close();
  model.close();

  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  mkdirSync(OUT_DIR, { recursive: true });
  const src = path.join(videoDir, webm);
  const start = Math.max(0, introMs / 1000 - 0.3).toFixed(2);
  const font = '/home/user/fonts/jb/fonts/ttf/JetBrainsMono-Regular.ttf';
  const caption = "drawbox=x=0:y=ih-34:w=iw:h=34:color=0x0b0f0c@0.92:t=fill,drawtext=fontfile=" + font + ":text='Real OASIS web workspace and tools · scripted demo model · reproducible with scripts/demo/record-web-demo.mjs':fontcolor=0x9fb3a6:fontsize=15:x=(w-text_w)/2:y=h-24";
  const mp4 = path.join(OUT_DIR, 'oasis-web-demo.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', start, '-i', src, '-vf', caption + ',fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', path.join(OUT_DIR, 'oasis-web-demo.gif')]);
  renameSync(path.join(dir, 'poster.png'), path.join(OUT_DIR, 'oasis-web-demo-poster.png'));
  rmSync(dir, { recursive: true, force: true });
  console.log('Wrote ' + mp4);
}

main().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
