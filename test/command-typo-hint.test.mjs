// `oasis doctr` or `oasis sessons` (a typo of a command) used to go to the
// model as a one-word task, spending a request on it. A single word one or two
// letters away from a command now suggests the command; ordinary one-word
// tasks still reach the agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('a one-word typo of a command suggests the command instead of starting a task', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-typo-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [typo, command] of [['doctr', 'doctor'], ['sessons', 'sessions'], ['skill', 'skills'], ['udpate', 'update'], ['shedule', 'schedule'], ['deplyo', 'deploy']]) {
    const r = await oasis([typo], home);
    assert.equal(r.code, 1, typo + ': ' + r.out);
    assert.match(r.out, new RegExp('Did you mean oasis ' + command + '\\?'), typo + ': ' + r.out);
    assert.doesNotMatch(r.out, /needs a model provider/, typo);
  }
  // Ordinary one-word tasks and multi-word tasks still go to the agent.
  for (const args of [['lint'], ['test'], ['refactor'], ['doctr', 'the', 'config']]) {
    const r = await oasis(args, home);
    assert.match(r.out, /needs a model provider/, args.join(' ') + ': ' + r.out);
  }
});
