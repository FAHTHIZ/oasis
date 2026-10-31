// Cross-platform process-tree cleanup: runs on Linux, macOS and Windows in CI.
// POSIX uses process groups; Windows uses `taskkill /T /F` tree termination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWorkspaceCommand } from '../src/tools.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function parentScript(pidFile, { ignoreTerm = false } = {}) {
  const grandchild = (ignoreTerm ? "process.on('SIGTERM',()=>{});" : '') + 'setInterval(()=>{},1000)';
  return [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    'const child=spawn(process.execPath,[' + "'-e'," + JSON.stringify(grandchild) + "],{stdio:'inherit'});",
    'fs.writeFileSync(' + JSON.stringify(pidFile) + ',String(child.pid));',
    "console.log('started');",
    'setInterval(()=>{},1000);'
  ].join('');
}

async function launch(t, { timeoutSeconds = 30, signal, ignoreTerm = false } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'oasis-tree-'));
  const pidFile = path.join(tmp, 'grandchild.pid');
  let pid = null;
  t.after(async () => {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  });
  const running = runWorkspaceCommand(tmp, process.execPath, ['-e', parentScript(pidFile, { ignoreTerm })], {
    autoApprove: true, ruleAllowed: true, approval: async () => true, timeoutSeconds, signal, persistOutputLogs: false
  });
  pid = await waitFor(async () => { try { return Number(await readFile(pidFile, 'utf8')) || null; } catch { return null; } }, 10000);
  assert.ok(pid, 'fixture grandchild should start');
  return { running, pid: () => pid };
}

test('cancellation stops the whole tree, including a grandchild holding inherited stdout/stderr pipes', async (t) => {
  const controller = new AbortController();
  const { running, pid } = await launch(t, { signal: controller.signal });
  const started = Date.now();
  controller.abort();
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
  assert.ok(result, 'command must settle even though a grandchild holds the output pipes');
  assert.equal(result.cancelled, true);
  assert.ok(Date.now() - started < 10000);
  assert.equal(await waitFor(() => !alive(pid()), 5000), true, 'grandchild must be terminated');
});

test('timeout stops the whole tree and reports timedOut', async (t) => {
  const { running, pid } = await launch(t, { timeoutSeconds: 5 });
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve(null), 20000))]);
  assert.ok(result, 'timed-out command must settle');
  assert.equal(result.timedOut, true);
  assert.match(String(result.stdout || ''), /started/, 'output produced before the timeout is preserved');
  assert.equal(await waitFor(() => !alive(pid()), 5000), true, 'grandchild must be terminated after a timeout');
});

test('a grandchild that ignores SIGTERM is force-killed after cancellation', async (t) => {
  const controller = new AbortController();
  const { running, pid } = await launch(t, { signal: controller.signal, ignoreTerm: true });
  controller.abort();
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
  assert.ok(result, 'command must settle');
  assert.equal(await waitFor(() => !alive(pid()), 8000), true, 'SIGTERM-ignoring grandchild must be escalated to a hard kill');
});
