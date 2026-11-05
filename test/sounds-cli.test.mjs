import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, chmod, readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('a terminal turn plays the finish chime and a completed step plays a tick', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-sounds-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'); await mkdir(bin);
  const played = path.join(home, 'played.log');
  await writeFile(path.join(bin, 'paplay'), '#!/bin/sh\nbasename "$1" >> ' + JSON.stringify(played) + '\n');
  await chmod(path.join(bin, 'paplay'), 0o755);
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    calls++;
    const message = calls === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'step one', status: 'completed' }, { content: 'step two', status: 'pending' }] }) } }] }
      : { role: 'assistant', content: 'all done' };
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] })); }, calls === 2 ? 3200 : 10);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const command = [process.execPath, cli, 'plan the work'].map((part) => JSON.stringify(part)).join(' ');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, OASIS_SIMPLE_INPUT: '1', OASIS_NO_STREAM: '1', OASIS_DISABLE_THEME_RELOAD: '1', HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_NOTIFY: 'off', OASIS_BACKGROUND_NOTICE: '0' };
  delete env.CI; delete env.SSH_CONNECTION; delete env.SSH_TTY; delete env.OASIS_SOUNDS;
  const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: home, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 40000);
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (out.includes('all done')) { clearInterval(iv); setTimeout(() => { child.stdin.end('/exit\n'); resolve(); }, 600); } }, 50);
    child.on('exit', () => { clearInterval(iv); resolve(); });
  });
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.on('exit', resolve));
  clearTimeout(timer);
  const log = await readFile(played, 'utf8').catch(() => '');
  assert.match(log, /^task-v50-s1\.wav$/m, 'tick for the completed step\n' + out.slice(-1500));
  assert.match(log, /^done-v50-s1\.wav$/m, 'chime for a turn over 3 seconds');
  assert.doesNotMatch(log, /error/);
});
