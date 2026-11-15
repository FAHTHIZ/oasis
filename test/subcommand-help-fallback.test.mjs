// `oasis bg --help` and `oasis auth --help` exited 1 with an error; `oasis review
// --help` (not a command) sent "review --help" to the model as a task; and a
// --help after `--` (`oasis mcp add x -- server --help`) printed help instead of
// reaching the passed-through command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function oasis(args, home) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
    for (const key of Object.keys(env)) if ((key.startsWith('OASIS_') && key !== 'OASIS_NO_UPDATE_CHECK') || key.endsWith('_API_KEY') || key.endsWith('_BASE_URL')) delete env[key];
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('--help on bg, auth and non-commands prints help; --help after -- is passed through', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-subhelp-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let r = await oasis(['bg', '--help'], home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /oasis bg \[list\] \| logs ID/);
  r = await oasis(['auth', '--help'], home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /oasis auth status/);
  r = await oasis(['review', '--help'], home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /oasis --help all|Usage/);
  assert.doesNotMatch(r.out, /needs a model provider/);
  r = await oasis(['mcp', 'add', 'echoer', '--yes', '--', 'echo', '--help'], home);
  assert.equal(r.code, 0, r.out);
  const saved = JSON.parse(await readFile(path.join(home, '.config', 'oasis', 'mcp-servers.json'), 'utf8'));
  assert.deepEqual(saved.servers.find((server) => server.name === 'echoer').args, ['--help']);
});
