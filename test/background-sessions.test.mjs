import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBackgroundSession, startExecJob, stopBackgroundSession, readEntry, listBackgroundSessions, renderLog, removeBackgroundSession } from '../src/background-sessions.mjs';
import { loadSession } from '../src/sessions.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('a background session runs detached, records status and saves the conversation', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-root-'));
  const { config } = await scriptedModel(t, [{ content: 'BACKGROUND DONE' }]);
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '' };
  const entry = await startBackgroundSession({ root, prompt: 'do the thing', env });
  assert.match(entry.id, /^bg-/);
  assert.ok(entry.pid > 0);
  let current = entry;
  for (let i = 0; i < 200 && current.status === 'running'; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); current = await readEntry(entry.id, env); }
  assert.equal(current.status, 'completed', await readFile(entry.logFile, 'utf8'));
  const log = renderLog(await readFile(entry.logFile, 'utf8'));
  assert.match(log, /BACKGROUND DONE/);
  assert.match(log, /\[done\]/);
  const saved = await loadSession(root, entry.sessionId, { env });
  assert.ok(saved.messages.some((m) => m.role === 'assistant' && /BACKGROUND DONE/.test(m.content || '')));
  assert.equal((await listBackgroundSessions(env)).length, 1);
  const listed = spawnSync(process.execPath, [CLI, 'bg', 'list'], { env, encoding: 'utf8' });
  assert.match(listed.stdout, new RegExp(entry.id + '\\s+completed'));
  await removeBackgroundSession(entry.id, env);
  assert.equal((await listBackgroundSessions(env)).length, 0);
});

test('stopping a background exec kills descendants that outlive the leader', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-stop-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-stop-root-'));
  t.after(() => Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(root, { recursive: true, force: true })
  ]));
  const readyPath = path.join(root, 'descendant.ready');
  const pidPath = path.join(root, 'descendant.pid');
  const childScript = path.join(root, 'stubborn-child.cjs');
  const parentScript = path.join(root, 'parent.cjs');
  await writeFile(childScript, [
    "process.on('SIGTERM', () => {});",
    "require('node:fs').writeFileSync(process.env.OASIS_TEST_READY_FILE, 'ready');",
    "setInterval(() => {}, 1000);"
  ].join('\n'));
  await writeFile(parentScript, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, [process.env.OASIS_TEST_CHILD_SCRIPT], { stdio: 'ignore', env: process.env });",
    "const publish = setInterval(() => { if (fs.existsSync(process.env.OASIS_TEST_READY_FILE)) { clearInterval(publish); fs.writeFileSync(process.env.OASIS_TEST_PID_FILE, String(child.pid)); } }, 10);",
    "setInterval(() => {}, 1000);"
  ].join('\n'));
  const env = {
    ...process.env,
    HOME: home,
    OASIS_CONFIG_DIR: path.join(home, 'cfg'),
    OASIS_TEST_READY_FILE: readyPath,
    OASIS_TEST_PID_FILE: pidPath,
    OASIS_TEST_CHILD_SCRIPT: childScript
  };
  const entry = await startExecJob({ root, command: process.execPath + ' ' + parentScript, env, name: 'tree-stop-fixture' });
  let pid = 0;
  try {
    const deadline = Date.now() + 5000;
    while (!pid && Date.now() < deadline) {
      try { pid = Number((await readFile(pidPath, 'utf8')).trim()); } catch {}
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid > 0, 'the descendant should be ready and publish its PID');
    assert.equal(await readFile(readyPath, 'utf8'), 'ready');

    const stopped = await stopBackgroundSession(entry.id, env);
    assert.equal(stopped.stopped, true);
    const stillRunning = async () => {
      try {
        const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
        const end = stat.lastIndexOf(')');
        return stat.slice(end + 2, end + 3) !== 'Z';
      } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        try { process.kill(pid, 0); return true; }
        catch (signalError) { return signalError && signalError.code === 'EPERM'; }
      }
    };
    const stopDeadline = Date.now() + 5000;
    while (await stillRunning() && Date.now() < stopDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await stillRunning(), false, 'background stop must kill a stubborn descendant after escalation');
  } finally {
    if (!pid) { try { pid = Number((await readFile(pidPath, 'utf8')).trim()); } catch {} }
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});

test('oasis --bg starts a session and prints how to follow it', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg2-'));
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '' };
  const result = spawnSync(process.execPath, [CLI, '-C', home, '--bg', 'tidy', 'up'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const id = /background session (bg-[a-z0-9]+)/.exec(result.stdout)[1];
  let entry = await readEntry(id, env);
  for (let i = 0; i < 200 && entry.status === 'running'; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); entry = await readEntry(id, env); }
  assert.equal(entry.prompt, 'tidy up');
  assert.equal(entry.status, 'completed');
});
