import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executePowerTool, timeoutToBackground, killAllBackground } from '../src/power-tools.mjs';

const posix = process.platform !== 'win32';

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-tobg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('a shell command still running at its timeout moves to the background and keeps its output', { skip: !posix }, async (t) => {
  const dir = await workspace(t);
  const session = { inbox: [] };
  t.after(() => killAllBackground(session.background));
  const ctx = { root: dir, ruleAllowed: true, approval: async () => true, env: process.env, session };
  const started = Date.now();
  const result = await executePowerTool('run_shell', { command: 'echo first; sleep 7; echo second', timeoutSeconds: 5 }, ctx, dir);
  assert.ok(Date.now() - started < 6500, 'the tool call returns at the timeout');
  assert.equal(result.timedOut, true);
  assert.equal(result.movedToBackground, true);
  assert.match(result.stdout, /first/);
  assert.match(result.id, /^bg_/);
  assert.match(result.message, /moved to the background.*command_output/);
  const entry = session.background.get(result.id);
  assert.equal(entry.status, 'running');
  assert.ok(await waitFor(() => entry.status !== 'running', 8000), 'the process keeps running and finishes on its own');
  assert.equal(entry.exitCode, 0);
  const more = await executePowerTool('command_output', { id: result.id }, ctx, dir);
  assert.equal(more.output.trim(), 'second', 'only the output after the hand-off is new');
});

test('OASIS_TIMEOUT_TO_BACKGROUND=0 restores stopping the command at the timeout', { skip: !posix }, async (t) => {
  const dir = await workspace(t);
  const session = {};
  const env = { ...process.env, OASIS_TIMEOUT_TO_BACKGROUND: '0' };
  assert.equal(timeoutToBackground(env), false);
  assert.equal(timeoutToBackground({}), true);
  const result = await executePowerTool('run_shell', { command: 'echo first; sleep 30', timeoutSeconds: 5 }, { root: dir, ruleAllowed: true, approval: async () => true, env, session }, dir);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.movedToBackground, true);
  assert.equal(session.background, undefined);
});

test('run_command gets the same hand-off at its timeout', { skip: !posix }, async (t) => {
  const { executeTool } = await import('../src/tools.mjs');
  const dir = await workspace(t);
  const session = {};
  t.after(() => killAllBackground(session.background));
  const result = await executeTool('run_command', { command: process.execPath, args: ['-e', "console.log('first');setTimeout(()=>console.log('second'),7000)"], timeoutSeconds: 5 }, { root: dir, session, autoApprove: true, ruleAllowed: true, approval: async () => true, env: process.env });
  assert.equal(result.movedToBackground, true, JSON.stringify(result));
  assert.match(result.stdout, /first/);
  const entry = session.background.get(result.id);
  assert.ok(await waitFor(() => entry.status !== 'running', 8000));
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.output.slice(entry.readOffset).trim(), 'second');
});
