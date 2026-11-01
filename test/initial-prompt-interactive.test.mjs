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
