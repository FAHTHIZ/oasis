import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

// `oasis -c` loads the conversation with the first prompt. /rewind typed first
// used to see no session and said "Nothing to rewind yet" although the
// checkpoints of the resumed conversation were saved on disk.
test('after oasis -c, /rewind before any prompt restores the resumed conversation\'s files', { skip: process.platform !== 'linux' || spawnSync('script', ['--version']).error ? 'needs script(1) on Linux' : false, timeout: 90000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-resume-rewind-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = path.join(home, 'proj');
  await import('node:fs/promises').then((fs) => fs.mkdir(project));
  await writeFile(path.join(project, 'math.mjs'), 'export const add = (a, b) => a - b;\n');
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    calls++;
    const message = calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'e1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'math.mjs', old_string: 'a - b', new_string: 'a + b' }) } }] }
      : { role: 'assistant', content: 'Fixed add.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_SIMPLE_INPUT: '1', OASIS_NO_STREAM: '1', OASIS_DISABLE_THEME_RELOAD: '1', OASIS_NO_UPDATE_CHECK: '1', HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'fixture', OASIS_VERIFICATION_GATE: '0' };
  // Async spawn: a synchronous one would block this process's fixture server.
  const first = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, '-p', 'fix add', '--permission-mode', 'accept-edits'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('exit', () => resolve(text));
  });
  assert.match(await readFile(path.join(project, 'math.mjs'), 'utf8'), /a \+ b/, first);

  const callsBefore = calls;
  const command = [process.execPath, cli, '-c'].map((part) => JSON.stringify(part)).join(' ');
  const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: project, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 40000);
  let sent = false;
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (!sent && /Resumed|❯/.test(out)) { sent = true; child.stdin.write('/rewind 1 code\n'); }
      if (/Rewound 1 turn|Nothing to rewind/.test(out)) { clearInterval(iv); child.stdin.end('/exit\n'); resolve(); }
    }, 50);
    child.on('exit', () => { clearInterval(iv); resolve(); });
  });
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.on('exit', resolve));
  clearTimeout(timer);
  assert.doesNotMatch(out, /Nothing to rewind yet/, out);
  assert.match(out, /Rewound 1 turn/, out);
  assert.match(await readFile(path.join(project, 'math.mjs'), 'utf8'), /a - b/, 'the file is back to its state before the resumed turn');
  assert.equal(calls, callsBefore, 'rewinding made no model call');
});
