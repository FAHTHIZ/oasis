// `oasis --permission-mode accept-edits permissions` printed "Permission mode:
// default (overridden: acceptEdits)": internal names, and the mode in force
// read as an aside. It now leads with the mode in force, in the names that
// --permission-mode and the help use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionModeName } from '../src/permission-modes.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function oasis(args, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: cwd, USERPROFILE: cwd, XDG_CONFIG_HOME: path.join(cwd, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('OASIS_') && key !== 'OASIS_NO_UPDATE_CHECK') delete env[key];
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('permission mode names match the --permission-mode spellings', () => {
  assert.equal(permissionModeName('default'), 'manual');
  assert.equal(permissionModeName('acceptEdits'), 'accept-edits');
  assert.equal(permissionModeName('dontAsk'), 'dont-ask');
  assert.equal(permissionModeName('plan'), 'plan');
});

test('oasis permissions leads with the mode in force', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-permnames-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let r = await oasis(['permissions'], dir);
  assert.match(r.out, /^Permission mode: manual\n/m, r.out);
  r = await oasis(['--permission-mode', 'accept-edits', 'permissions'], dir);
  assert.match(r.out, /^Permission mode: accept-edits \(from --permission-mode; settings: manual\)\n/m, r.out);
  assert.doesNotMatch(r.out, /acceptEdits|overridden/);
});

// `oasis permissions` printed "bypass-permissions" as the mode's name, but
// --permission-mode bypass-permissions was rejected. Every displayed name must
// be accepted back, and the error must list the names users see.
test('every displayed mode name is accepted by --permission-mode', async () => {
  const { PERMISSION_MODES, normalizePermissionMode } = await import('../src/permission-modes.mjs');
  for (const mode of PERMISSION_MODES) assert.equal(normalizePermissionMode(permissionModeName(mode)), mode, mode);
  assert.equal(normalizePermissionMode('bypass_permissions'), 'bypassPermissions');
  const { permissionModeList } = await import('../src/permission-modes.mjs');
  assert.equal(permissionModeList(), 'manual (default), accept-edits, plan, auto, dont-ask, bypass-permissions');
});
