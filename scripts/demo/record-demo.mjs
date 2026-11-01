#!/usr/bin/env node
// Records the README terminal demo as an asciicast v2 file.
//
// What is real: the OASIS CLI, its terminal UI, tools, approval prompt,
// safety policy, diffs and the project's test run. What is scripted: the
// model. A tiny local OpenAI-compatible server replays fixed replies (below),
// so the recording is reproducible and needs no API key.
//
//   node scripts/demo/record-demo.mjs [out.cast]
//   python3 scripts/demo/render-demo.py out.cast assets/demo/oasis-terminal-demo
//
// The demo project is the taskflow fixture from evals/tasks/taskflow-overdue-today.

import http from 'node:http';
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'assets', 'demo', 'oasis-terminal-demo.cast'));
const COLS = 104;
const ROWS = 32;

// ---- Scripted model -------------------------------------------------------

const FIX_OLD = '  return new Date(task.due) < now;';
const FIX_NEW = '  return task.due < toDay(now);';
const TEST_OLD = "  assert.equal(daysUntil('2026-11-08', NOW), 7);\n});";
const TEST_NEW = TEST_OLD + "\n\ntest('a task due today is not overdue late in the day', () => {\n  const lateToday = new Date(2026, 10, 1, 23, 59);\n  assert.equal(isOverdue({ due: '2026-11-01', status: 'open' }, lateToday), false);\n});";

const SCRIPT = {
  fix: [
    { text: "I'll start by finding where overdue is decided.", tool: ['search_files', { query: 'isOverdue', path: 'src' }] },
    { tool: ['read_file', { path: 'src/dates.mjs' }] },
    { text: "Found it. `new Date('2026-11-01')` parses a date-only string as **UTC** midnight, so east of UTC the task turns overdue hours before the local day ends. Due dates are local calendar days, so compare days instead of instants.", tool: ['edit_file', { path: 'src/dates.mjs', old_string: FIX_OLD, new_string: FIX_NEW }] },
    { text: 'Now a regression test that fails on the old code.', tool: ['edit_file', { path: 'test/dates.test.mjs', old_string: TEST_OLD, new_string: TEST_NEW }] },
    { tool: ['run_command', { command: 'npm', args: ['test'] }] },
    { tool: ['git_diff', {}] },
    { text: '**Fixed.** `isOverdue` compared a UTC instant with local time; it now compares calendar days with `toDay(now)`.\n\n- `src/dates.mjs` — one-line root-cause fix\n- `test/dates.test.mjs` — regression test for a task due today, checked at 23:59\n\nAll 20 project tests pass. No existing test was changed.' }
  ],
  clean: [
    { text: 'Removing everything untracked, including ignored files.', tool: ['run_command', { command: 'git', args: ['clean', '-fdx'] }] },
    { text: "OASIS blocked `git clean -fdx`: it would permanently delete untracked and ignored files, and Git can't bring them back. Nothing was removed. If you want this, run `git clean -n` first to preview the list, then run it yourself." }
  ]
};

function scriptFor(messages) {
  const users = messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('<'));
  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && /clean everything|Fix it/i.test(String(m.content || '')));
  const which = lastUser && /clean everything/i.test(lastUser.content) ? 'clean' : 'fix';
  const start = messages.lastIndexOf(lastUser);
  const replies = messages.slice(start).filter((m) => m.role === 'assistant').length;
  return { which, step: SCRIPT[which][Math.min(replies, SCRIPT[which].length - 1)], users: users.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let callId = 0;

async function streamReply(res, step, delayMs) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', model: 'demo-model', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
  await sleep(delayMs);
  if (step.text) {
    const words = step.text.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 2) { send({ content: words.slice(i, i + 2).join('') }); await sleep(38); }
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
    // Side requests (titles, suggestions) get a short plain answer.
    if (!Array.isArray(request.tools) || !request.tools.length) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Fix overdue check' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 4, total_tokens: 54 } }));
    }
    const { step, which } = scriptFor(messages);
    const first = messages.filter((m) => m.role === 'assistant').length === 0 || (which === 'clean' && step === SCRIPT.clean[0]);
    await streamReply(res, step, first ? 2600 : 900);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- Demo project ----------------------------------------------------------

function makeProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oasis-demo-'));
  const home = path.join(dir, 'home');
  const project = path.join(home, 'taskflow');
  cpSync(path.join(ROOT, 'evals', 'tasks', 'taskflow-overdue-today', 'repo'), project, { recursive: true });
  writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n.cache/\n');
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.com' } });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'taskflow');
  return { dir, project, home };
}

// ---- Recording ---------------------------------------------------------------

async function main() {
  const server = await startModel();
  const { dir, project, home } = makeProject();
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TZ: 'Asia/Dhaka',
    OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_PROTOCOL: 'openai-compatible', OASIS_MODEL: 'demo-model', OASIS_API_KEY: 'demo',
    OASIS_NO_UPDATE_CHECK: '1', OASIS_TIP: 'off', OASIS_MOTION: 'full', OASIS_DISABLE_TELEMETRY: '1', OASIS_TRUST_WORKSPACE: '1'
  };
  const events = [];
  const t0 = Date.now();
  let screen = '';
  const term = pty.spawn(process.execPath, [path.join(ROOT, 'src', 'cli.mjs')], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: project, env });
  term.onData((data) => { events.push([(Date.now() - t0) / 1000, 'o', data]); screen = (screen + data).slice(-20000); });
  let exited = false;
  term.onExit(() => { exited = true; });

  const waitFor = async (pattern, timeoutMs = 60000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (pattern.test(screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) return true;
      if (exited) throw new Error('OASIS exited while waiting for ' + pattern);
      await sleep(100);
    }
    throw new Error('Timed out waiting for ' + pattern + '\n--- screen tail ---\n' + screen.slice(-1500));
  };
  const type = async (text, perChar = 45) => { for (const ch of text) { term.write(ch); await sleep(perChar + Math.random() * 30); } };
  const mark = () => { screen = ''; };

  await waitFor(/OASIS/);
  await sleep(1800);
  mark();
  await type('Tasks due today show as overdue late in the evening. Fix it and add a regression test.');
  await sleep(500);
  term.write('\r');
  await waitFor(/Allow|approve|\[y\/N\]|\(y\/n\)/i, 90000);
  await sleep(1400);
  term.write('y');
  await sleep(250);
  term.write('\r');
  await waitFor(/No existing test was changed/, 90000);
  await sleep(3200);
  mark();
  await type('Now clean everything that is not committed.');
  await sleep(500);
  term.write('\r');
  await waitFor(/run it yourself/, 90000);
  await sleep(4000);
  term.kill();
  server.close();

  const header = { version: 2, width: COLS, height: ROWS, timestamp: Math.floor(t0 / 1000), title: 'OASIS terminal demo (scripted model, real runtime)', env: { TERM: 'xterm-256color', SHELL: '/bin/bash' } };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
  rmSync(dir, { recursive: true, force: true });
  console.log('Wrote ' + OUT + ' (' + events.length + ' events, ' + events.at(-1)[0].toFixed(1) + ' s)');
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
