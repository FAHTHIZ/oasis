// `oasis doctor --json` printed the text report and exited 0, so a script
// parsing it got garbage. Unknown options are now rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

test('oasis doctor rejects unknown options', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-doctor-opt-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: home, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /unknown option --json/);
  assert.doesNotMatch(r.stdout, /OASIS check/);
});
