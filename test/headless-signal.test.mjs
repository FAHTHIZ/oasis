import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('SIGTERM during oasis -p stops the running command and exits 143', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-sigterm-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-sigterm-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const pidFile = path.join(root, 'child.pid');
  await writeFile(path.join(root, 'sleeper.js'), "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid)); setTimeout(() => {}, 60000);\n");
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'node', args: ['sleeper.js'], timeout_ms: 60000 }), { content: 'done' }]);
  const child = spawn(process.execPath, [CLI, '-C', root, '-p', 'run the sleeper', '--yes'], {
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errText = '';
  let outText = '';
  child.stderr.on('data', (chunk) => { errText += chunk; });
  child.stdout.on('data', (chunk) => { outText += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  let pid = 0;
  for (let i = 0; i < 200 && !pid; i++) {
    pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pid > 0, 'the command started: ' + errText);
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  child.kill('SIGTERM');
  const { code } = await closed;
  assert.equal(code, 143, errText);
  assert.match(errText, /Received SIGTERM; stopping/);
  assert.match(outText, /Stopped by SIGTERM before the task finished\./);
  assert.doesNotMatch(outText, /cancelled by the user/);
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pid), false, 'the command was stopped with Oasis');
});

test('a -p run stopped part-way is saved and says how to resume it', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-sigsave-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-sigsave-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const pidFile = path.join(root, 'child.pid');
  await writeFile(path.join(root, 'sleeper.js'), "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid)); setTimeout(() => {}, 60000);\n");
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'node', args: ['sleeper.js'], timeout_ms: 60000 }), { content: 'done' }]);
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' };
  const child = spawn(process.execPath, [CLI, '-C', root, '-p', 'run the sleeper', '--yes'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = '';
  child.stderr.on('data', (chunk) => { errText += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  let pid = 0;
  for (let i = 0; i < 200 && !pid; i++) {
    pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pid > 0, 'the command started: ' + errText);
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  child.kill('SIGTERM');
  await closed;
  const match = errText.match(/The work so far is saved\. Continue it with: oasis --resume ([0-9a-f-]{36})/);
  assert.ok(match, errText);
  const { loadSession } = await import('../src/sessions.mjs');
  const saved = await loadSession(root, match[1], { env });
  assert.ok(saved.messages.some((message) => message.role === 'user' && /run the sleeper/.test(String(message.content))), 'the original request is kept');
});

test('a run stopped by timeout(1), which sends SIGTERM to the process and its group, still saves and says how to resume', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-sigtwice-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-sigtwice-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const pidFile = path.join(root, 'child.pid');
  await writeFile(path.join(root, 'sleeper.js'), "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid)); setTimeout(() => {}, 60000);\n");
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'node', args: ['sleeper.js'], timeout_ms: 60000 }), { content: 'done' }]);
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' };
  const child = spawn('timeout', ['4', process.execPath, CLI, '-C', root, '-p', 'run the sleeper', '--yes'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = '';
  child.stderr.on('data', (chunk) => { errText += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  t.after(async () => { const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0')); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert.equal(await closed, 124, errText);
  assert.equal((errText.match(/Received SIGTERM/g) || []).length, 1, errText);
  assert.match(errText, /The work so far is saved\. Continue it with: oasis --resume/);
});
