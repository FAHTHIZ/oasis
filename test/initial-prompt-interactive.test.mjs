import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

// On a terminal, `oasis "task"` and `oasis -i "task"` run the task and then keep the session open.
for (const args of [['first task please'], ['-i', 'first task please'], ['--prompt-interactive=first task please']]) {
  test('on a terminal, ' + JSON.stringify(args) + ' runs the task, then takes follow-ups', { skip: process.platform !== 'linux' }, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-initial-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const prompts = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const users = JSON.parse(body).messages.filter((m) => m.role === 'user').map((m) => String(m.content));
      prompts.push(users.at(-1));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'reply ' + users.length } }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const command = [process.execPath, cli, ...args].map((part) => JSON.stringify(part)).join(' ');
    const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: home, env: { ...process.env, OASIS_SIMPLE_INPUT: '1', OASIS_NO_STREAM: '1', OASIS_DISABLE_THEME_RELOAD: '1', HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'fixture', OASIS_ONE_SHOT: '' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 40000);
    let sent = false;
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (!sent && out.includes('reply 1')) { sent = true; child.stdin.write('second message\n'); }
        if (out.includes('reply 2')) { clearInterval(iv); child.stdin.end('/exit\n'); resolve(); }
      }, 50);
      child.on('exit', () => { clearInterval(iv); resolve(); });
    });
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.on('exit', resolve));
    clearTimeout(timer);
    assert.match(prompts[0] || '', /first task please/, out);
    assert.match(prompts[1] || '', /second message/, out);
  });
}

const runTty = async (args, home, port, steps) => {
  const command = [process.execPath, cli, ...args].map((part) => JSON.stringify(part)).join(' ');
  const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: home, env: { ...process.env, OASIS_SIMPLE_INPUT: '1', OASIS_NO_STREAM: '1', OASIS_DISABLE_THEME_RELOAD: '1', HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + port + '/v1', OASIS_MODEL: 'fixture' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 40000);
  let step = 0;
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      while (step < steps.length && out.includes(steps[step][0])) { child.stdin.write(steps[step][1] + '\n'); step++; }
      if (step >= steps.length) { clearInterval(iv); resolve(); }
    }, 50);
    child.on('exit', () => { clearInterval(iv); resolve(); });
  });
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.on('exit', resolve));
  clearTimeout(timer);
  return out;
};

test('-r without an ID lists saved sessions; `oasis resume --last` continues the latest', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-resume-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body).messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'noted ' + seen.length } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  await runTty(['remember the word pelican'], home, port, [['noted 1', '/exit']]);
  let out = await runTty(['-r'], home, port, [['Saved sessions:', '/exit']]);
  assert.match(out, /Saved sessions:[\s\S]*remember the word pelican[\s\S]*\/resume NUMBER/, out);
  out = await runTty(['resume', '--last'], home, port, [['>', 'what was the word'], ['noted 2', '/exit']]);
  assert.ok(seen[1].some((m) => /pelican/.test(m)), 'the resumed conversation was sent: ' + JSON.stringify(seen[1]));
});
