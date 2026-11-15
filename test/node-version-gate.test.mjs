import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'oasis.mjs');
// Pretend to be an older Node.js: npm only warns about "engines", so this is
// what a user with Node 20 actually runs.
const OLD_NODE = 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"20.20.2"})';

function run(args, env = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-node-gate-'));
  return spawnSync(process.execPath, ['--import', OLD_NODE, entry, ...args], {
    cwd: home, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData'), OASIS_CONFIG_DIR: '', OASIS_ALLOW_UNSUPPORTED_NODE: '', NO_COLOR: '1', ...env }
  });
}

test('an unsupported Node.js stops with the version found and the fix', () => {
  const result = run(['-p', 'hello']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OASIS needs Node\.js 22\.19 or newer; this is Node\.js v20\.20\.2/);
  assert.match(result.stderr, /nodejs\.org/);
  assert.doesNotMatch(result.stderr, /No model provider/);
});

test('--version still answers and doctor still reports on an unsupported Node.js', () => {
  assert.equal(run(['--version']).status, 0);
  const doctor = run(['doctor']);
  assert.equal(doctor.status, 1, 'doctor fails when Node.js is too old');
  assert.match(doctor.stdout, /Node\.js 22\.19\+: CHECK — found v/);
  assert.match(doctor.stdout, /Next step: install Node\.js 22\.19 or newer/);
});

test('OASIS_ALLOW_UNSUPPORTED_NODE=1 skips the gate', () => {
  const result = run(['-p', 'hello'], { OASIS_ALLOW_UNSUPPORTED_NODE: '1' });
  assert.doesNotMatch(result.stderr, /OASIS needs Node\.js/);
  assert.match(result.stderr, /No model provider is configured/);
});
