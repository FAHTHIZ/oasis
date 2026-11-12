#!/usr/bin/env node
// Records an unscripted terminal run with a real model as an asciicast v2 file.
//
// Nothing is scripted except the keystrokes: the prompt is typed, each
// approval is answered with Enter (the first choice, "Allow once"), and /exit
// is sent when the agent has been idle for a while after its last reply.
//
//   DEMO_HOME=/path/with/config node scripts/demo/record-live-demo.mjs PROJECT "PROMPT" out.cast
//   python3 scripts/demo/render-demo.py out.cast assets/demo/oasis-real-model-demo
//
// The model is whatever `oasis connect` saved under DEMO_HOME (default HOME).

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import stripAnsi from 'strip-ansi';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [project, prompt, out] = process.argv.slice(2);
if (!project || !prompt || !out) { console.error('usage: record-live-demo.mjs PROJECT "PROMPT" out.cast'); process.exit(2); }
const COLS = Number(process.env.DEMO_COLS || 100), ROWS = Number(process.env.DEMO_ROWS || 30);
const home = process.env.DEMO_HOME || process.env.HOME;

const events = [];
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
let screen = '', lastOutput = Date.now(), answered = 0, exiting = false;

const child = pty.spawn(process.execPath, [path.join(ROOT, 'src', 'oasis.mjs')], {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: project,
  env: { ...process.env, HOME: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', OASIS_NO_UPDATE_CHECK: '1' }
});
child.onData((data) => {
  events.push([Number(now().toFixed(4)), 'o', data]);
  screen = (screen + stripAnsi(data)).slice(-6000);
  lastOutput = Date.now();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function type(text) { for (const ch of text) { child.write(ch); await sleep(28 + Math.random() * 40); } }

const done = new Promise((resolve) => child.onExit(resolve));
(async () => {
  await sleep(4000);
  if (/trust/i.test(screen) && /\b(yes|trust)\b/i.test(screen)) { child.write('\r'); await sleep(2500); }
  await type(prompt); await sleep(600); child.write('\r'); screen = '';
  const limit = Date.now() + Number(process.env.DEMO_MINUTES || 20) * 60e3;
  while (Date.now() < limit && !exiting) {
    await sleep(1000);
    const tail = screen.slice(-1500);
    if (/Allow once/.test(tail) && Date.now() - lastOutput > 1200) {
      await sleep(1200); child.write('\r'); answered++; screen = ''; continue;
    }
    // Finished: a reply arrived and nothing has been printed for a while.
    if (Date.now() - lastOutput > Number(process.env.DEMO_IDLE_SECONDS || 45) * 1000 && !/esc to interrupt|Thinking|Working/i.test(tail.slice(-400))) break;
  }
  exiting = true;
  await sleep(1500); await type('/exit'); await sleep(400); child.write('\r');
  setTimeout(() => child.kill(), 8000);
})();
await done;
writeFileSync(out, JSON.stringify({ version: 2, width: COLS, height: ROWS, timestamp: Math.floor(t0 / 1000), env: { TERM: 'xterm-256color' }, title: 'OASIS' }) + '\n' + events.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(JSON.stringify({ seconds: Math.round(now()), approvals: answered, events: events.length }));
