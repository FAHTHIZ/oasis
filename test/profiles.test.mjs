import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { getConfigDirectory, activeProfile } from '../src/config.mjs';
import { profileCommand, listProfiles } from '../src/profiles.mjs';

const run = promisify(execFile);
const CLI = path.resolve('src/cli.mjs');

async function setup(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-profiles-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  return { home, env, base: path.join(home, '.config', 'oasis') };
}
const sink = () => { let text = ''; return { write: (s) => { text += s; }, get text() { return text; } }; };

test('profiles select an isolated config directory; OASIS_CONFIG_DIR wins', async (t) => {
  const { home, env, base } = await setup(t);
  assert.equal(getConfigDirectory(env, home), base);
  assert.equal(getConfigDirectory({ ...env, OASIS_PROFILE: 'work' }, home), path.join(base, 'profiles', 'work'));
  assert.equal(getConfigDirectory({ ...env, OASIS_PROFILE: 'default' }, home), base);
  assert.equal(getConfigDirectory({ ...env, OASIS_PROFILE: 'work', OASIS_CONFIG_DIR: '/tmp/x' }, home), path.resolve('/tmp/x'));
  assert.throws(() => getConfigDirectory({ ...env, OASIS_PROFILE: '../evil' }, home), /Invalid OASIS profile/);
});

test('create copies config but not sessions; use makes it sticky; delete needs --yes', async (t) => {
  const { home, env, base } = await setup(t);
  await mkdir(path.join(base, 'sessions', 'p1'), { recursive: true });
  await writeFile(path.join(base, 'sessions', 'p1', 'a.json'), '{}');
  await writeFile(path.join(base, 'config.json'), JSON.stringify({ model: 'm' }));
  await mkdir(path.join(base, 'skills', 's1'), { recursive: true });
  await writeFile(path.join(base, 'skills', 's1', 'SKILL.md'), 'x');
  await mkdir(path.join(base, 'memory', 'user'), { recursive: true });
  const out = sink();
  await profileCommand(['create', 'work'], { env, home, stdout: out });
  const dir = path.join(base, 'profiles', 'work');
  assert.match(out.text, /copied config.json, skills/);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')).model, 'm');
  await assert.rejects(stat(path.join(dir, 'sessions')));
  await assert.rejects(stat(path.join(dir, 'memory')));
  await assert.rejects(profileCommand(['create', 'work'], { env, home, stdout: sink() }), /already exists/);
  await profileCommand(['create', 'clone', '--from', 'work', '--with-memory'], { env, home, stdout: sink() });

  await profileCommand(['use', 'work'], { env, home, stdout: sink() });
  assert.equal(activeProfile(env, home), 'work');
  assert.equal(getConfigDirectory(env, home), dir);
  // An explicit OASIS_PROFILE (even "default") overrides the sticky choice.
  assert.equal(getConfigDirectory({ ...env, OASIS_PROFILE: 'default' }, home), base);
  const profiles = await listProfiles(env, home);
  assert.deepEqual(profiles.map((p) => [p.name, p.active]), [['default', false], ['clone', false], ['work', true]]);
  assert.equal(profiles[0].sessions, 1);

  await assert.rejects(profileCommand(['delete', 'work', '--yes'], { env, home, stdout: sink() }), /is active/);
  await profileCommand(['use', 'default'], { env, home, stdout: sink() });
  await assert.rejects(profileCommand(['delete', 'work'], { env, home, stdout: sink() }), /--yes/);
  await profileCommand(['delete', 'work', '--yes'], { env, home, stdout: sink() });
  await assert.rejects(stat(dir));
  await assert.rejects(profileCommand(['delete', 'default', '--yes'], { env, home, stdout: sink() }), /cannot be deleted/);
});

test('the CLI accepts --profile anywhere and runs profile commands', async (t) => {
  const { home, env } = await setup(t);
  const childEnv = { ...process.env, ...env, OASIS_CONFIG_DIR: '', OASIS_PROFILE: '' };
  delete childEnv.OASIS_CONFIG_DIR;
  delete childEnv.OASIS_PROFILE;
  await run(process.execPath, [CLI, 'profile', 'create', 'lab'], { env: childEnv });
  const { stdout } = await run(process.execPath, [CLI, '--profile', 'lab', 'profile', 'show'], { env: childEnv });
  assert.match(stdout, /Profile: lab/);
  const listed = await run(process.execPath, [CLI, 'profile', 'list'], { env: childEnv });
  assert.match(listed.stdout, /lab/);
  await assert.rejects(run(process.execPath, [CLI, '--profile', 'bad/name', 'profile', 'show'], { env: childEnv }), (error) => /Invalid OASIS profile/.test(String(error.stderr) + String(error.stdout)));
});
