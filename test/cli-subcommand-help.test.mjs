import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'oasis.mjs');
const run = (args, cwd) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HOME: cwd, OASIS_PROTOCOL: '', OASIS_BASE_URL: '' }, timeout: 20000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));

test('COMMAND --help prints usage instead of running the command', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-help-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const init = await run(['init', '--help'], dir);
  assert.equal(init.code, 0);
  assert.match(init.stdout, /oasis init/);
  assert.deepEqual(await readdir(dir), [], 'init --help must not create OASIS.md');
  const acp = await run(['acp', '--help'], dir);
  assert.match(acp.stdout, /Agent Client Protocol/);
});

test('oasis web --help prints its options', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-help-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const web = await run(['web', '--help'], dir);
  assert.equal(web.code, 0);
  assert.match(web.stdout, /--allow-insecure-lan/);
});
