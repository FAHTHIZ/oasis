import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'oasis.mjs');

test('a reader that closes the pipe early does not crash the CLI with an EPIPE stack trace', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-epipe-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [CLI, 'doctor'], { env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'config'), OASIS_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // Like `| head -1`: read one chunk, then close the pipe.
  child.stdout.once('data', () => child.stdout.destroy());
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error' event/);
  assert.equal(code, 0, stderr);
});
