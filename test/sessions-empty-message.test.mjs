// The empty `oasis sessions` list said "Use oasis --continue to save/resume a
// session", although every chat is saved automatically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

test('empty oasis sessions explains that chats are saved automatically', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-sessions-empty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'sessions'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('close', () => resolve(text));
  });
  assert.match(out, /saved automatically/);
  assert.match(out, /oasis -c/);
  assert.doesNotMatch(out, /to save\/resume a session/);
});
