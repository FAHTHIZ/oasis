import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBackgroundSession, readEntry, backgroundDirectory, inboxPath, drainInbox, sendToBackgroundSession, summarizeActivity, currentBootId, describeEntry, renderLog } from '../src/background-sessions.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function fakeEntry(env, fields) {
  const dir = backgroundDirectory(env);
  await mkdir(dir, { recursive: true });
  const entry = { id: 'bg-abc12345', runId: 'r1', sessionId: 's1', root: os.tmpdir(), prompt: 'task', status: 'running', startedAt: new Date().toISOString(), logFile: path.join(dir, 'bg-abc12345.log'), pid: process.pid, bootId: currentBootId(), ...fields };
  await writeFile(path.join(dir, entry.id + '.json'), JSON.stringify(entry));
  return entry;
}

test('a run whose process died or whose machine rebooted is reported as interrupted', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-bgl-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  await fakeEntry(env, {});
  assert.equal((await readEntry('bg-abc12345', env)).status, 'running');
  await fakeEntry(env, { pid: 2147483646 });
  assert.equal((await readEntry('bg-abc12345', env)).status, 'interrupted');
  await fakeEntry(env, { bootId: 'some-earlier-boot' });
  const rebooted = await readEntry('bg-abc12345', env);
  assert.equal(rebooted.status, 'interrupted');
  assert.equal(rebooted.interruptedBy, 'reboot');
  await fakeEntry(env, { status: 'completed', pid: 2147483646 });
  assert.equal((await readEntry('bg-abc12345', env)).status, 'completed');
  await fakeEntry(env, { pid: 2147483646 });
  const listed = spawnSync(process.execPath, [CLI, 'bg', 'list'], { env, encoding: 'utf8' });
  assert.match(listed.stdout, /stopped unexpectedly/);
  assert.match(listed.stdout, /bg-abc12345\s+interrupted/);
});

test('messages queue in the inbox, drain once, and are refused for stopped runs', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-bgl-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  await fakeEntry(env, {});
  await sendToBackgroundSession('bg-abc12345', 'first', env);
  await sendToBackgroundSession('bg-abc12345', 'second', env);
  assert.deepEqual(await drainInbox('bg-abc12345', env), ['first', 'second']);
  assert.deepEqual(await drainInbox('bg-abc12345', env), []);
  await assert.rejects(sendToBackgroundSession('bg-abc12345', '   ', env), /Usage/);
  await fakeEntry(env, { status: 'completed' });
  await assert.rejects(sendToBackgroundSession('bg-abc12345', 'late', env), /completed/);
  await fakeEntry(env, { kind: 'exec' });
  await assert.rejects(sendToBackgroundSession('bg-abc12345', 'x', env), /shell job/);
});

test('activity summary shows the latest step', () => {
  const log = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'm', cwd: '/w' }),
    JSON.stringify({ type: 'assistant', text: 'Looking at the failing test first.' }),
    JSON.stringify({ type: 'tool_use', name: 'run_command', input: { command: 'npm test' } })
  ].join('\n');
  assert.equal(summarizeActivity(log), 'running run_command npm test');
  assert.equal(summarizeActivity(log + '\n' + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All fixed' })), 'done: All fixed');
  assert.equal(summarizeActivity(''), '');
  assert.match(describeEntry({ id: 'bg-1', status: 'running', startedAt: new Date().toISOString(), root: '/x/proj', prompt: 'p' }, 'running tests'), /└ running tests/);
  assert.match(renderLog(JSON.stringify({ type: 'system', subtype: 'steer_received', text: 'use pnpm' })), /\[message\] use pnpm/);
});

test('a background agent receives a message sent to its inbox and answers it', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-bgl-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bgl-root-'));
  const sawMessage = (payload) => JSON.stringify(payload.messages).includes('also say banana');
  const { config, requests } = await scriptedModel(t, [
    (payload) => ({ content: sawMessage(payload) ? 'BANANA' : 'FIRST DONE' }),
    (payload) => ({ content: sawMessage(payload) ? 'BANANA' : 'NO MESSAGE' })
  ]);
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '' };
  await mkdir(backgroundDirectory(env), { recursive: true });
  // Queued before the run starts: the first inbox poll delivers it, either mid-turn or as a follow-up turn.
  await appendFile(inboxPath('bg-steer0001', env), JSON.stringify({ text: 'please also say banana' }) + '\n');
  const entry = await startBackgroundSession({ id: 'bg-steer0001', root, prompt: 'do the thing', env });
  let current = entry;
  for (let i = 0; i < 300 && current.status === 'running'; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); current = await readEntry(entry.id, env); }
  const raw = await readFile(entry.logFile, 'utf8');
  assert.equal(current.status, 'completed', raw);
  assert.ok(requests.some(sawMessage), 'the model saw the message');
  assert.match(renderLog(raw), /BANANA/);
  assert.match(renderLog(raw), /\[message\] please also say banana/);
});
