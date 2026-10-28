import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runHeadless } from '../src/headless.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

async function tmp() { return await mkdtemp(path.join(os.tmpdir(), 'oasis-headless-')); }

test('json output reports the result, usage, and denied approvals', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'git', args: ['--version'] }), { content: 'Could not write.' }]);
  let out = '';
  const { exitCode, summary } = await runHeadless({ prompt: 'write a.txt', root, config, outputFormat: 'json', sessionOptions: { settings }, write: (text) => { out += text; } });
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.type, 'result');
  assert.equal(parsed.subtype, 'success');
  assert.equal(parsed.result, 'Could not write.');
  assert.ok(parsed.num_turns >= 2);
  assert.equal(parsed.usage.total_tokens, parsed.num_turns * 15);
  assert.equal(parsed.permission_denials.length, 1);
  assert.match(parsed.permission_denials[0].detail, /git "--version"/);
  assert.equal(parsed.permission_denials[0].tool_name, 'run_command');
  assert.deepEqual(summary, parsed);
});

test('stream-json emits init, tool, assistant, and result events; allow rules work', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'git', args: ['--version'] }), { content: 'Wrote it.' }]);
  let out = '';
  await runHeadless({ prompt: 'write', root, config, outputFormat: 'stream-json', sessionOptions: { settings, allowedTools: ['Bash(git:*)'] }, write: (text) => { out += text; } });
  const events = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['system', 'tool_use', 'tool_result', 'assistant', 'result']);
  assert.equal(events[0].subtype, 'init');
  assert.equal(events[1].name, 'run_command');
  assert.match(events[2].content, /git version/);
  assert.equal(events.at(-1).permission_denials.length, 0);
});

test('max turns stops a looping model and reports error_max_turns', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [(payload, requests) => toolCall('c' + requests.length, 'list_files', { path: '.' })]);
  let out = '';
  const { exitCode } = await runHeadless({ prompt: 'loop', root, config, outputFormat: 'json', maxTurns: 2, sessionOptions: { settings }, write: (text) => { out += text; } });
  const parsed = JSON.parse(out);
  assert.equal(parsed.subtype, 'error_max_turns');
  assert.equal(exitCode, 0);
});

test('oasis -p runs end to end with piped stdin and text output', async (t) => {
  const root = await tmp();
  const home = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'The error is a typo.' }]);
  const child = spawn(process.execPath, [CLI, '-C', root, '-p', 'explain this error', '--model', 'override-model'], {
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.end('TypeError: foo is not a function\n');
  let stdoutText = '';
  child.stdout.on('data', (chunk) => { stdoutText += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stdoutText);
  assert.equal(stdoutText.trim(), 'The error is a typo.');
  assert.equal(requests[0].model, 'override-model');
  const user = requests[0].messages.find((message) => message.role === 'user');
  assert.match(user.content, /explain this error\n\n<stdin>\nTypeError: foo is not a function/);
});
