// `oasis skills add` and `oasis skills install` had no way back: removing a
// skill meant finding and deleting its folder by hand. `oasis skills remove
// NAME` deletes it from the folders OASIS installs into, and asks first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function oasis(args, cwd, home) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
    for (const key of Object.keys(env)) if ((key.startsWith('OASIS_') && key !== 'OASIS_NO_UPDATE_CHECK') || key.endsWith('_API_KEY')) delete env[key];
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}
const exists = (file) => access(file).then(() => true, () => false);

test('oasis skills remove deletes an installed skill after confirmation', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-skrm-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'oasis-skrm-proj-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(project, { recursive: true, force: true })]));
  const local = path.join(project, '.agents', 'skills', 'pdf-tools');
  const bundled = path.join(project, '.oasis', 'skills', 'review');
  const global = path.join(home, '.config', 'agents', 'skills', 'pdf-tools');
  for (const dir of [local, bundled, global]) { await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n'); }

  // Without a terminal or --yes it refuses and deletes nothing.
  let r = await oasis(['skills', 'remove', 'pdf-tools'], project, home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--yes/);
  assert.ok(await exists(local));

  r = await oasis(['skills', 'remove', 'pdf-tools', '--yes'], project, home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Removed skill "pdf-tools"/);
  assert.ok(!(await exists(local)));
  assert.ok(await exists(global), 'the user-level copy is kept without --global');

  r = await oasis(['skills', 'remove', 'pdf-tools', '--global', '--yes'], project, home);
  assert.equal(r.code, 0, r.out);
  assert.ok(!(await exists(global)));

  r = await oasis(['skills', 'remove', 'review', '--yes'], project, home);
  assert.equal(r.code, 0, r.out);
  assert.ok(!(await exists(bundled)));

  r = await oasis(['skills', 'remove', 'nothere', '--yes'], project, home);
  assert.equal(r.code, 1);
  assert.match(r.out, /No installed skill named "nothere"/);
  r = await oasis(['skills', 'remove', '../x', '--yes'], project, home);
  assert.equal(r.code, 1);
  assert.match(r.out, /Skill names/);
});
