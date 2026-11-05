import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, closeSession } from '../src/agent.mjs';

// Outside a git repository, "check git_status before editing" only costs a
// failing tool call.
async function promptFor(git) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-gitline-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-gitline-cfg-'));
  if (git) execFileSync('git', ['init', '-q'], { cwd: root });
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0' };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'x' } });
  try { return String(session.messages[0].content); } finally {
    await closeSession(session);
    await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true });
  }
}

test('the git_status reminder is only in the prompt inside a git repository', async () => {
  assert.match(await promptFor(true), /Check git_status before editing/);
  assert.doesNotMatch(await promptFor(false), /Check git_status before editing/);
});
