#!/usr/bin/env node
// Records the web app with a real, unscripted model.
//
// Everything is real: the OASIS web server, the browser workspace, the tools,
// the approvals, the project's tests and the model. Only the browser input is
// automated: the prompt is typed, an optional steering note is sent while the
// agent works, and every approval is answered with Allow (in the waiting step
// when it is shown there, otherwise in the approval sheet).
//
//   DEMO_HOME=/path/with/config node scripts/demo/record-web-real-demo.mjs PROJECT "PROMPT" OUT_BASENAME
//
// Options (environment):
//   DEMO_STEER="note"       a note to send while the agent works
//   DEMO_SIZE=1280x800      viewport (390x844 records the phone layout)
//   DEMO_THEME=dark|light   colour scheme
//   DEMO_CAPTION="text"     caption bar under the video
//   DEMO_MINUTES=10         give up after this long
//
// The model is whatever `oasis connect` saved under DEMO_HOME (default HOME).
// Needs Playwright with Chromium and ffmpeg. Writes OUT.mp4, OUT.gif and
// OUT-poster.png. Long model waits are kept as they happened; trim them in
// editing if you want, and say so next to the video.

import { readdirSync, mkdirSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const [project, prompt, out] = process.argv.slice(2);
if (!project || !prompt || !out) { console.error('usage: record-web-real-demo.mjs PROJECT "PROMPT" OUT_BASENAME'); process.exit(2); }
const [W, H] = (process.env.DEMO_SIZE || '1280x800').split('x').map(Number);
const home = process.env.DEMO_HOME || os.homedir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  process.env.HOME = home;
  process.env.OASIS_CONFIG_DIR = process.env.OASIS_CONFIG_DIR || path.join(home, '.config', 'oasis');
  process.env.OASIS_NO_UPDATE_CHECK = '1';
  const { loadConfig } = await import('../../src/config.mjs');
  const { startOasisWebServer } = await import('../../src/web.mjs');
  const config = await loadConfig({ env: process.env });
  const modelName = String(config?.model || '');
  const token = 'oasis-real-demo-' + Math.random().toString(16).slice(2).padEnd(24, '0');
  const app = await startOasisWebServer({ root: path.resolve(project), host: '127.0.0.1', port: 0, env: process.env, token });

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'oasis-real-web-'));
  const videoDir = path.join(tmp, 'video');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: process.env.DEMO_THEME || 'dark', serviceWorkers: 'block', recordVideo: { dir: videoDir, size: { width: W, height: H } } });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:' + app.port + '/app/#token=' + token, { waitUntil: 'domcontentloaded' });
  await page.locator('#input').waitFor({ state: 'visible' });
  if (modelName) await page.waitForFunction((m) => (document.querySelector('#modelChip')?.textContent || '').includes(m), modelName, { timeout: 30000 }).catch(() => {});
  const introMs = Date.now() - t0;
  await sleep(1500);

  const box = page.locator('#input');
  await box.click();
  await box.pressSequentially(prompt, { delay: 30 });
  await sleep(500);
  await page.locator('#sendButton').click();
  await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 30000 });

  const steer = process.env.DEMO_STEER;
  let steered = !steer, approvals = 0, idleSince = 0;
  const limit = Date.now() + Number(process.env.DEMO_MINUTES || 10) * 60e3;
  const started = Date.now();
  while (Date.now() < limit) {
    if (!steered && Date.now() - started > 6000) {
      await box.click();
      await box.pressSequentially(steer, { delay: 38 });
      await sleep(400);
      await box.press('Enter');
      steered = true;
    }
    const inStep = page.locator('.step-allow:visible').first();
    const sheetAllow = page.locator('#approvalSheet:not([hidden]) #allowButton');
    if (await inStep.count()) { await sleep(1500); await inStep.click().catch(() => {}); approvals++; await sleep(500); continue; }
    if (await sheetAllow.count() && await sheetAllow.isVisible()) { await sleep(1500); await sheetAllow.click().catch(() => {}); approvals++; await sleep(500); continue; }
    const busy = await page.evaluate(() => document.body.classList.contains('busy'));
    if (!busy) { idleSince ||= Date.now(); if (Date.now() - idleSince > 4000) break; } else idleSince = 0;
    await sleep(250);
  }
  await sleep(2000);
  const changes = page.locator('[role="tab"][data-tab="changes"]');
  if (await changes.isVisible().catch(() => false)) { await changes.click(); await sleep(4000); }
  await page.screenshot({ path: path.join(tmp, 'poster.png') });
  const seconds = Math.round((Date.now() - t0) / 1000);
  await context.close();
  await browser.close();
  await app.close();

  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  const base = path.resolve(out);
  mkdirSync(path.dirname(base), { recursive: true });
  const start = Math.max(0, introMs / 1000 - 0.3).toFixed(2);
  const font = process.env.DEMO_FONT || '/home/user/fonts/jb/fonts/ttf/JetBrainsMono-Regular.ttf';
  const text = (process.env.DEMO_CAPTION || `Unscripted run · real model: ${modelName || 'configured model'} · real OASIS web app, tools and tests`).replace(/[:']/g, (c) => '\\' + c);
  const vf = `pad=iw:ih+34:0:0:color=0x0b0f0c,drawtext=fontfile=${font}:text='${text}':fontcolor=0x9fb3a6:fontsize=15:x=(w-text_w)/2:y=h-24,fps=30,format=yuv420p`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', start, '-i', path.join(videoDir, webm), '-vf', vf, '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', base + '.mp4']);
  renameSync(path.join(tmp, 'poster.png'), base + '-poster.png');
  rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify({ seconds, approvals, out: base + '.mp4' }));
}

main().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
