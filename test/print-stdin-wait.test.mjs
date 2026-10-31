import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function fixture(t) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    bodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-pstdin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'fixture', OASIS_API_KEY: 'k', OASIS_STDIN_WAIT_SECONDS: '1', NODE_TEST_CONTEXT: '' };
  return { bodies, dir, env };
}

function run(dir, env, args, feed) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (code) => { clearTimeout(killer); child.stdin.destroy(); resolve({ code, stdout, stderr }); });
    feed(child.stdin);
  });
}

test('oasis -p does not hang on an inherited stdin pipe that never sends data', async (t) => {
  const { dir, env } = await fixture(t);
  const started = Date.now();
  const result = await run(dir, env, ['-p', 'ping'], () => {});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /pong/);
  assert.match(result.stderr, /stdin is open but sent nothing/);
  assert.ok(Date.now() - started < 20000);
});

test('oasis -p still reads slow piped input that starts within the wait', async (t) => {
  const { bodies, dir, env } = await fixture(t);
  const result = await run(dir, env, ['-p', 'summarize'], (input) => { setTimeout(() => { input.write('LOG-LINE-42\n'); setTimeout(() => input.end('LOG-LINE-43\n'), 1500); }, 300); });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(bodies.some((body) => body.includes('LOG-LINE-42') && body.includes('LOG-LINE-43')));
});
