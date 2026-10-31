import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/tools.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (check()) return true; await wait(50); }
  return false;
}
const inboxText = (session) => JSON.stringify(session.inbox || []);

test('background commands honor max_seconds and report the timeout', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-'));
  const session = {};
  try {
    const started = await executeTool('run_command', { command: 'sleep', args: ['30'], run_in_background: true, max_seconds: 1 }, { root, session, autoApprove: true });
    const entry = session.background.get(started.id);
    assert.ok(await until(() => entry.status !== 'running'), 'process was stopped');
    assert.equal(entry.status, 'timed_out');
    assert.ok(await until(() => inboxText(session).includes('max_seconds=1')), 'agent is told why it stopped');
  } finally {
    for (const entry of session.background?.values() || []) try { entry.child.kill('SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('quiet background commands trigger a single stuck notice', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-'));
  const session = {};
  const previous = process.env.OASIS_BACKGROUND_STUCK_SECONDS;
  process.env.OASIS_BACKGROUND_STUCK_SECONDS = '1';
  try {
    const started = await executeTool('run_command', { command: 'sleep', args: ['20'], run_in_background: true }, { root, session, autoApprove: true });
    assert.ok(await until(() => inboxText(session).includes('no output for about')), 'stuck notice delivered');
    await wait(1500);
    assert.equal((inboxText(session).match(/no output for about/g) || []).length, 1, 'only one notice');
    const listed = await executeTool('list_background', {}, { root, session });
    assert.ok(listed.processes.find((item) => item.id === started.id).secondsSinceOutput >= 1);
  } finally {
    if (previous === undefined) delete process.env.OASIS_BACKGROUND_STUCK_SECONDS; else process.env.OASIS_BACKGROUND_STUCK_SECONDS = previous;
    for (const entry of session.background?.values() || []) try { entry.child.kill('SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('background run_shell commands now notify on exit', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-'));
  const session = {};
  try {
    await executeTool('run_shell', { command: 'echo hi && exit 3', run_in_background: true }, { root, session, autoApprove: true, permissionMode: 'bypassPermissions' });
    assert.ok(await until(() => inboxText(session).includes('exited with code 3')), inboxText(session));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
