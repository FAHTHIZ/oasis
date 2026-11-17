#!/usr/bin/env node
// How smooth a terminal turn feels, measured instead of eyeballed.
//
// Runs `oasis` in a pseudo-terminal against a scripted local model that does
// what real turns do: streams reasoning, plans with todo_write, reads files in
// parallel, slowly streams a large write_file call, runs a command that prints
// output over a few seconds, then streams a long markdown reply. Everything
// the CLI writes is timestamped, and the run is scored against targets:
//
//   frozen gap      longest time with no screen update while the turn runs   < 0.25 s
//   writes per sec  busiest second of terminal writes                        <= 70
//   synced frames   share of live-region writes inside DEC 2026 sync marks   >= 95 %
//   cursor hides    cursor hide sequences in the turn (each one can flicker)  <= 4
//
//   npm run bench:feel                  # full motion
//   npm run bench:feel -- --motion lite # low-power mode
//   npm run bench:feel -- --json        # machine-readable result
//   npm run bench:feel -- --slack 3     # looser time target on a busy CI runner
//
// Needs the optional node-pty dependency. Exit code 1 when a target is missed.
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const motion = args.includes('--motion') ? args[args.indexOf('--motion') + 1] : 'full';
const asJson = args.includes('--json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pty;
try { pty = (await import('node-pty')).default; } catch {
  console.error('bench:feel needs node-pty (an optional dependency). Install it with npm install.');
  process.exit(2);
}

const big = Array.from({ length: 120 }, (_, i) => `export function f${i}(x) { return x * ${i} + 1; }`).join('\n');
const longText = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: the change keeps **behaviour** identical while making \`f${i}\` faster.`).join('\n\n') + '\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.';
const STEPS = [
  { reason: 'I need to understand the layout of the project first, then plan the change. '.repeat(5), text: 'I will plan this first.', tools: [['todo_write', { todos: [{ content: 'Explore the code', activeForm: 'Exploring the code', status: 'in_progress' }, { content: 'Write the module', status: 'pending' }, { content: 'Run checks', status: 'pending' }] }]] },
  { delay: 1200, tools: [['read_file', { path: 'package.json' }], ['search_files', { query: 'export', path: '.' }], ['list_files', { path: '.' }]] },
  { delay: 800, text: 'Now writing the module.', tools: [['write_file', { path: 'src/big.mjs', content: big }]], slowArgs: true },
  { delay: 600, tools: [['run_command', { command: 'node', args: ['-e', 'let i=0;const t=setInterval(()=>{console.log("build step "+(++i));if(i==5)clearInterval(t)},600)'] }]] },
  { delay: 600, tools: [['todo_write', { todos: [{ content: 'Explore the code', status: 'completed' }, { content: 'Write the module', status: 'completed' }, { content: 'Run checks', status: 'completed' }] }]] },
  { delay: 800, text: longText, fast: true }
];

let callId = 0;
function stepFor(messages) {
  const start = messages.map((m) => m.role === 'user' && typeof m.content === 'string' && /FEEL/.test(m.content)).lastIndexOf(true);
  return STEPS[Math.min(messages.slice(start).filter((m) => m.role === 'assistant').length, STEPS.length - 1)];
}
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (/\/models/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'feel-model', context_length: 131072 }] })); return; }
  let request = {};
  try { request = JSON.parse(body); } catch {}
  if (!request.tools || !request.tools.length) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Feel check' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })); return; }
  const step = stepFor(request.messages || []);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'feel-model', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
  await sleep(step.delay || 1000);
  if (step.reason) for (const piece of step.reason.match(/.{1,6}/g)) { send({ reasoning_content: piece }); await sleep(20); }
  if (step.text) for (const piece of step.fast ? step.text.match(/.{1,3}/gs) : step.text.split(/(?=\s)/)) { send({ content: piece }); await sleep(step.fast ? 5 : 35); }
  (step.tools || []).forEach(() => {});
  for (let i = 0; i < (step.tools || []).length; i++) {
    const [name, input] = step.tools[i];
    callId++;
    const json = JSON.stringify(input);
    if (step.slowArgs) {
      send({ tool_calls: [{ index: i, id: 'c' + callId, type: 'function', function: { name, arguments: '' } }] });
      for (const piece of json.match(/.{1,24}/gs)) { send({ tool_calls: [{ index: i, function: { arguments: piece } }] }); await sleep(15); }
    } else send({ tool_calls: [{ index: i, id: 'c' + callId, type: 'function', function: { name, arguments: json } }] });
  }
  send({}, step.tools ? 'tool_calls' : 'stop');
  res.write('data: ' + JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 4200, completion_tokens: 120, total_tokens: 4320 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const dir = mkdtempSync(path.join(os.tmpdir(), 'oasis-feel-'));
const home = path.join(dir, 'home');
const project = path.join(home, 'project');
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'package.json'), '{"name":"feel","type":"module"}\n');
writeFileSync(path.join(project, 'src', 'a.mjs'), 'export const a = 1;\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
const env = { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_PROTOCOL: 'openai-compatible', OASIS_MODEL: 'feel-model', OASIS_API_KEY: 'feel', OASIS_NO_UPDATE_CHECK: '1', OASIS_TIP: 'off', OASIS_MOTION: motion, OASIS_DISABLE_TELEMETRY: '1', OASIS_TRUST_WORKSPACE: '1', OASIS_SOUNDS: 'off', OASIS_NOTIFY: 'off' };

const events = [];
let screen = '';
const t0 = Date.now();
const term = pty.spawn(process.execPath, [path.join(ROOT, 'src', 'cli.mjs')], { name: 'xterm-256color', cols: 100, rows: 30, cwd: project, env });
term.onData((data) => { events.push([Date.now() - t0, data]); screen = (screen + data).slice(-20000); });
const plain = () => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const waitFor = async (re, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(plain())) return true; await sleep(100); } return false; };

let ok = await waitFor(/OASIS/);
await sleep(1200);
screen = '';
for (const ch of 'FEEL: build the module and run checks') { term.write(ch); await sleep(10); }
const sentAt = Date.now() - t0;
term.write('\r');
let doneAt = 0;
// Time spent in approval dialogs is the person's, not a freeze.
const waits = [];
const deadline = Date.now() + 90000;
while (ok && Date.now() < deadline) {
  const text = plain();
  if (/Do you want to proceed/.test(text)) { const shown = Date.now() - t0; screen = screen.replace(/Do you want to proceed/g, ''); await sleep(300); term.write('\r'); waits.push([shown - 200, Date.now() - t0 + 200]); }
  if (/Done ·|Done\.\s/.test(text) && /\bDone\b.*\d+s/.test(text)) { doneAt = Date.now() - t0; break; }
  await sleep(100);
}
await sleep(500);
term.kill();
server.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
if (!doneAt) { console.error('The scripted turn did not finish; last screen:\n' + plain().slice(-1500)); process.exit(2); }

// Score the turn (from Enter to the summary line), ignoring the first 300 ms.
const turn = events.filter(([t]) => t >= sentAt + 300 && t <= doneAt);
let frozen = 0;
const inDialog = (t) => waits.some(([from, to]) => t >= from && t <= to);
for (let i = 1; i < turn.length; i++) if (!inDialog(turn[i - 1][0]) && !inDialog(turn[i][0])) frozen = Math.max(frozen, turn[i][0] - turn[i - 1][0]);
const perSecond = new Map();
for (const [t] of turn) perSecond.set(Math.floor(t / 1000), (perSecond.get(Math.floor(t / 1000)) || 0) + 1);
const busiest = Math.max(0, ...perSecond.values());
const live = turn.filter(([, data]) => /\x1b\[J|\x1b\[2K/.test(data));
const synced = live.filter(([, data]) => data.includes('\x1b[?2026h')).length;
const syncShare = live.length ? synced / live.length : 1;
const hides = turn.reduce((sum, [, data]) => sum + (data.match(/\x1b\[\?25l/g) || []).length, 0);
const result = {
  motion,
  turnSeconds: +((doneAt - sentAt) / 1000).toFixed(1),
  frozenGapSeconds: +(frozen / 1000).toFixed(2),
  busiestWritesPerSecond: busiest,
  syncedShare: +syncShare.toFixed(3),
  cursorHides: hides
};
// Shared CI machines stall now and then; --slack N scales the time target
// (the 4.8 s freezes this guards against still fail at any sane slack).
const slack = args.includes('--slack') ? Math.max(1, Number(args[args.indexOf('--slack') + 1]) || 1) : 1;
const gapTarget = Math.round((motion === 'lite' ? 0.6 : 0.25) * slack * 100) / 100;
const targets = [
  ['frozen gap', result.frozenGapSeconds < gapTarget, result.frozenGapSeconds + ' s', '< ' + gapTarget + ' s'],
  ['writes per second', busiest <= 70, String(busiest), '<= 70'],
  ['synced frames', syncShare >= 0.95, Math.round(syncShare * 100) + ' %', '>= 95 %'],
  ['cursor hides', hides <= 4, String(hides), '<= 4']
];
if (asJson) console.log(JSON.stringify({ ...result, pass: targets.every(([, pass]) => pass) }, null, 2));
else {
  console.log('OASIS terminal feel (' + motion + ' motion, turn ' + result.turnSeconds + ' s)');
  for (const [name, pass, value, target] of targets) console.log('  ' + (pass ? 'ok  ' : 'MISS') + '  ' + name.padEnd(18) + value.padStart(8) + '   target ' + target);
}
process.exit(targets.every(([, pass]) => pass) ? 0 : 1);
