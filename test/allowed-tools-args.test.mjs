// Found while using OASIS as a new user (15 Nov 2026): with
// `oasis -p --allowedTools "run_command(npm:*)" "run_command(node:*)" "task"`
// only the first rule was read; the second became the first words of the
// task, and every `node ...` command was refused. The help promises comma- or
// space-separated lists, which a single argument also did not honour.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitRuleList } from '../src/cli.mjs';
import { deniedHint } from '../src/headless.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('splitRuleList splits on commas and spaces outside parentheses', () => {
  assert.deepEqual(splitRuleList('run_command(npm test:*),Edit(src/**)'), ['run_command(npm test:*)', 'Edit(src/**)']);
  assert.deepEqual(splitRuleList('run_command(npm:*) run_command(node:*)'), ['run_command(npm:*)', 'run_command(node:*)']);
  assert.deepEqual(splitRuleList('Read, Bash(git log:*)  Write'), ['Read', 'Bash(git log:*)', 'Write']);
  assert.deepEqual(splitRuleList('Bash(echo a,b)'), ['Bash(echo a,b)']);
});

test('deniedHint names each suggested rule once', () => {
  const denied = [
    { tool_name: 'run_command', tool_input: { command: 'node index.js add 1 food' } },
    { tool_name: 'run_command', tool_input: { command: 'node index.js list' } }
  ];
  const hint = deniedHint(denied, { env: {} });
  assert.match(hint, /--allowedTools "run_command\(node index\.js:\*\)",/);
  assert.equal(hint.split('run_command(node index.js:*)').length - 1, 1);
});

test('--allowedTools takes several rule arguments and leaves the task text alone', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-allow-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-allow-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'touch', args: ['made.txt'] }), { content: 'Done.' }]);
  const child = spawn(process.execPath, [CLI, '-C', root, '-p', '--allowedTools', 'run_command(npm:*)', 'run_command(touch:*)', 'make the file'], {
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stdout + stderr);
  const user = requests[0].messages.find((message) => message.role === 'user');
  assert.equal(String(user.content).trim(), 'make the file');
  assert.doesNotMatch(stderr, /Not approved/);
  assert.ok(existsSync(path.join(root, 'made.txt')), 'the allowed command ran');
});
