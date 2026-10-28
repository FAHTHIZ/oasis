import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBackgroundSession, readEntry, listBackgroundSessions, renderLog, removeBackgroundSession } from '../src/background-sessions.mjs';
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
