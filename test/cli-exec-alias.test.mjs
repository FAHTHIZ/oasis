import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../src/config.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('`oasis exec PROMPT` runs headless like `oasis -p PROMPT`', async (t) => {
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-exec-cfg-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: config };
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'x' }, { env });
  const run = spawnSync(process.execPath, [cli, 'exec', 'hello', '--output-format', 'json'], { cwd: config, env, input: '', encoding: 'utf8', timeout: 60000 });
  const line = run.stdout.trim().split('\n').pop();
  const result = JSON.parse(line);
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, true);
  assert.match(result.result, /model provider/);
});

test('Codex-style --output-schema FILE and -o FILE work with exec', async (t) => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { readFile, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-exec-o-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"answer":42}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, OASIS_LOCAL_CONTEXT_PROBE: '0', OASIS_MODEL_INFO_PROBE: '0' };
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'x' }, { env });
  await writeFile(path.join(dir, 'schema.json'), JSON.stringify({ type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] }));
  const out = path.join(dir, 'last.txt');
  const child = spawn(process.execPath, [cli, 'exec', 'What is the answer?', '--output-schema', path.join(dir, 'schema.json'), '-o', out, '--output-format', 'json'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  const result = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(code, 0, stdout);
  assert.deepEqual(result.structured_output, { answer: 42 });
  assert.equal(await readFile(out, 'utf8'), '{"answer":42}\n');
});

test('Codex and Gemini CLI permission flags map to OASIS modes', async (t) => {
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-exec-flags-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: config };
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'x' }, { env });
  const cases = [[['--full-auto'], 'acceptEdits'], [['--sandbox', 'read-only'], 'plan'], [['--approval-mode', 'auto_edit'], 'acceptEdits'], [['--approval-mode=plan'], 'plan'], [['-a', 'never'], 'auto'], [['--yolo'], 'bypassPermissions'], [['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'], 'bypassPermissions']];
  for (const [flags, mode] of cases) {
    const run = spawnSync(process.execPath, [cli, 'exec', 'hi', '--output-format', 'stream-json', '--verbose', ...flags], { cwd: config, env, input: '', encoding: 'utf8', timeout: 60000 });
    const init = JSON.parse(run.stdout.split('\n')[0]);
    assert.equal(init.permission_mode, mode, flags.join(' '));
  }
  const bad = spawnSync(process.execPath, [cli, 'exec', 'hi', '--sandbox', 'everything'], { cwd: config, env, input: '', encoding: 'utf8', timeout: 60000 });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /--sandbox must be read-only, workspace-write or danger-full-access/);
});

test('Aider flags: --message, --message-file, and --test-cmd with --auto-test', async (t) => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { readFile, writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-aider-flags-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompts = [];
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const users = parsed.messages.filter((m) => m.role === 'user');
    if (users.length === 1 && !parsed.messages.some((m) => m.role === 'tool')) prompts.push(String(typeof users[0].content === 'string' ? users[0].content : JSON.stringify(users[0].content)));
    calls += 1;
    const writes = parsed.messages.some((m) => m.role === 'tool');
    const message = writes || !String(prompts.at(-1) || '').includes('edit please')
      ? { role: 'assistant', content: 'done' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x\n' }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, OASIS_LOCAL_CONTEXT_PROBE: '0', OASIS_MODEL_INFO_PROBE: '0' };
  delete env.OASIS_AUTO_TEST;
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'x' }, { env });
  const run = async (args) => {
    const child = spawn(process.execPath, [cli, ...args, '--output-format', 'json'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    return { code, out };
  };
  let result = await run(['--message', 'hello from aider']);
  assert.equal(result.code, 0, result.out);
  assert.match(prompts.at(-1), /hello from aider/);
  await writeFile(path.join(dir, 'msg.txt'), 'from a file');
  result = await run(['--message-file', 'msg.txt']);
  assert.equal(result.code, 0, result.out);
  assert.match(prompts.at(-1), /from a file/);
  const marker = path.join(dir, 'tests-ran');
  const testCmd = JSON.stringify(process.execPath) + ' -e "require(\'fs\').writeFileSync(process.argv[1], \'1\')" ' + JSON.stringify(marker);
  result = await run(['--message', 'edit please', '--yes-always', '--test-cmd', testCmd, '--auto-test']);
  assert.equal(result.code, 0, result.out);
  assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'x\n');
  assert.ok(existsSync(marker), 'auto-test ran the --test-cmd command:\n' + result.out);
  assert.ok(calls >= 4);
});
