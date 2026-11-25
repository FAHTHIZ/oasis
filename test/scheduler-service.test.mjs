// oasis schedule install: the scheduler as an OS service on each platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { installService, serviceSpec, serviceStatus, uninstallService } from '../src/scheduler-service.mjs';

const fakeRunner = (replies = {}) => {
  const calls = [];
  const runner = (command, args, _options, done) => {
    calls.push([command, ...args].join(' '));
    const reply = Object.entries(replies).find(([key]) => calls.at(-1).includes(key))?.[1] || {};
    setImmediate(() => done(reply.error || null, reply.stdout || '', reply.stderr || ''));
  };
  return { runner, calls };
};

async function home() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-svc-'));
  return { HOME: dir, OASIS_CONFIG_DIR: path.join(dir, 'cfg'), PATH: '/usr/bin:/bin', USER: 'me' };
}

test('linux: writes a systemd user unit, enables it, reports status and removes it', async () => {
  const env = await home();
  const { runner, calls } = fakeRunner({ 'is-active': { stdout: 'active\n' } });
  const { spec } = await installService({ env, platform: 'linux', runner, nodePath: '/opt/node', entry: '/opt/oasis/src/oasis.mjs', interval: 60 });
  assert.equal(spec.file, path.join(env.HOME, '.config', 'systemd', 'user', 'oasis-scheduler.service'));
  const unit = await readFile(spec.file, 'utf8');
  assert.match(unit, /ExecStart="\/opt\/node" "\/opt\/oasis\/src\/oasis\.mjs" "schedule" "daemon" "--interval" "60"/);
  assert.match(unit, /Environment="OASIS_CONFIG_DIR=.*cfg"/, 'the daemon reads the same config');
  assert.match(unit, /Restart=on-failure/);
  assert.deepEqual(calls, ['systemctl --user daemon-reload', 'systemctl --user enable --now oasis-scheduler.service']);
  const status = await serviceStatus({ env, platform: 'linux', runner });
  assert.equal(status.installed, true); assert.equal(status.running, true);
  const removed = await uninstallService({ env, platform: 'linux', runner });
  assert.equal(removed.removed, true);
  await assert.rejects(stat(spec.file));
});

test('linux: a failed enable leaves no unit file and explains why', async () => {
  const env = await home();
  const { runner } = fakeRunner({ 'daemon-reload': { error: Object.assign(new Error('x'), { code: 1 }), stderr: 'Failed to connect to user scope bus' } });
  await assert.rejects(installService({ env, platform: 'linux', runner }), /no systemd user session/);
  await assert.rejects(stat(path.join(env.HOME, '.config', 'systemd', 'user', 'oasis-scheduler.service')));
});

test('macOS: a LaunchAgent plist with escaped paths, bootstrapped into the GUI domain', async () => {
  const env = await home();
  const { runner, calls } = fakeRunner({ bootout: { error: new Error('not loaded') } });
  const { spec } = await installService({ env, platform: 'darwin', runner, nodePath: '/Apps/A&B/node', entry: '/x/oasis.mjs' });
  const plist = await readFile(spec.file, 'utf8');
  assert.match(plist, /<string>\/Apps\/A&amp;B\/node<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(calls.some((call) => call.startsWith('launchctl bootstrap gui/')), 'bootstrapped even though bootout failed');
});

test('windows: a logon task through schtasks; unsupported platforms say what to do', async () => {
  const env = await home();
  const { runner, calls } = fakeRunner();
  await installService({ env, platform: 'win32', runner, nodePath: 'C:\\node\\node.exe', entry: 'C:\\oasis\\src\\oasis.mjs' });
  assert.match(calls[0], /^schtasks \/Create \/TN OASIS Scheduler \/SC ONLOGON .*\/TR "C:\\node\\node.exe" "C:\\oasis\\src\\oasis.mjs" "schedule" "daemon"/);
  assert.throws(() => serviceSpec({ platform: 'freebsd', env }), /oasis schedule daemon/);
});
