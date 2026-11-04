import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod, stat } from 'node:fs/promises';
import { normalizeSshSettings, remoteCommandLine, sshWrap, shellQuote, detectSshRuntime } from '../src/ssh-backend.mjs';
import { resolveSandbox, wrapCommand } from '../src/sandbox.mjs';

const hasRsync = process.platform !== 'win32' && spawnSync('rsync', ['--version']).status === 0;

test('ssh settings are validated against option and shell injection', () => {
  assert.match(normalizeSshSettings({}, {}).error, /Set the SSH host/);
  assert.match(normalizeSshSettings({ host: '-oProxyCommand=evil' }, {}).error, /not valid/);
  assert.match(normalizeSshSettings({ host: 'me@box;rm' }, {}).error, /not valid/);
  assert.match(normalizeSshSettings({ host: 'box', remoteRoot: '/srv/$(id)' }, {}).error, /remoteRoot/);
  assert.match(normalizeSshSettings({ host: 'box', remoteRoot: '/srv/../etc' }, {}).error, /remoteRoot/);
  assert.match(normalizeSshSettings({ host: 'box', port: 70000 }, {}).error, /port/);
  assert.match(normalizeSshSettings({ host: 'box', exclude: ['--delete-excluded'] }, {}).error, /exclude/);
  const ok = normalizeSshSettings({ host: 'me@gpu-box', port: 2222 }, {}, '/home/me/My App');
  assert.match(ok.remoteRoot, /^~\/oasis-workspaces\/My_App-[0-9a-f]{8}$/);
  assert.equal(normalizeSshSettings({}, { OASIS_SSH_HOST: 'alias', OASIS_SSH_REMOTE_ROOT: '/w' }).remoteRoot, '/w');
});

test('remote command lines quote every argument and map the working directory', () => {
  const ssh = normalizeSshSettings({ host: 'box', remoteRoot: '~/w/app' }, {}, '/local/app');
  assert.equal(remoteCommandLine('npm', ['test', "it's; rm -rf /"], ssh, '/local/app/pkg'), 'cd "$HOME"/w/app/pkg && CI=1 OASIS_SANDBOXED=1 exec npm test ' + shellQuote("it's; rm -rf /"));
  const none = sshWrap('ls', ['-la'], { ssh: { ...ssh, sync: 'none' } }, '/local/app');
  assert.equal(none.command, 'ssh');
  assert.deepEqual(none.args.slice(-2), ['box', 'cd "$HOME"/w/app && CI=1 OASIS_SANDBOXED=1 exec ls -la']);
  assert.ok(none.args.includes('BatchMode=yes'));
  assert.ok(sshWrap('vim', [], { ssh: { ...ssh, sync: 'none' } }, '/local/app', { tty: true }).args.includes('-tt'));
  assert.throws(() => sshWrap('ls', [], { ssh }, '/local/app', { platform: 'win32' }), /POSIX shell/);
  assert.equal(detectSshRuntime({ error: 'nope' }).reason, 'nope');
});

test('ssh backend pushes the workspace, runs remotely and pulls changes back', { skip: !hasRsync && 'rsync is not installed' }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-ssh-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const local = path.join(base, 'local'), remoteHome = path.join(base, 'remote-home'), bin = path.join(base, 'bin');
  await mkdir(path.join(local, 'node_modules'), { recursive: true });
  await mkdir(remoteHome); await mkdir(bin);
  await writeFile(path.join(local, 'input.txt'), 'hello\n');
  await writeFile(path.join(local, 'node_modules', 'big.js'), 'x');
  // A stand-in ssh: drops options and the host, then runs the "remote" command locally with HOME set to the fake remote.
  await writeFile(path.join(bin, 'ssh'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o|-p|-i|-l) shift 2;; -T|-tt) shift;; *) break;; esac; done\nshift\necho "$*" >> "' + base + '/ssh.log"\nHOME="' + remoteHome + '" exec /bin/sh -c "$*"\n');
  await chmod(path.join(bin, 'ssh'), 0o755);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const ssh = normalizeSshSettings({ host: 'me@box', remoteRoot: '~/work/app' }, {}, local);
  const launch = sshWrap('/bin/sh', ['-c', 'cat input.txt > out.txt; echo remote-ok; pwd; test ! -e node_modules && echo no-deps'], { ssh }, local);
  const result = await new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { cwd: local, env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /remote-ok/);
  assert.match(result.out, new RegExp(path.join(remoteHome, 'work', 'app').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.out, /no-deps/);
  assert.equal(await readFile(path.join(remoteHome, 'work/app/input.txt'), 'utf8'), 'hello\n');
  assert.equal(await readFile(path.join(local, 'out.txt'), 'utf8'), 'hello\n');
  assert.ok((await stat(path.join(local, 'node_modules', 'big.js'))).isFile());
  // Exit codes come back unchanged.
  const fail = sshWrap('/bin/sh', ['-c', 'exit 7'], { ssh }, local);
  assert.equal(spawnSync(fail.command, fail.args, { cwd: local, env }).status, 7);
});

test('resolveSandbox and wrapCommand route the ssh backend', () => {
  const sandbox = resolveSandbox({ sandbox: { enabled: true, backend: 'ssh', ssh: { host: 'box', sync: 'none' } } }, '/tmp/x');
  assert.equal(sandbox.backend, 'ssh');
  assert.equal(sandbox.ssh.host, 'box');
  if (sandbox.available) assert.equal(wrapCommand('ls', [], sandbox, '/tmp/x').command, 'ssh');
  else assert.throws(() => wrapCommand('ls', [], sandbox, '/tmp/x'), /unavailable/);
  const broken = resolveSandbox({ sandbox: { enabled: true, backend: 'ssh', ssh: {} } }, '/tmp/x');
  assert.equal(broken.available, false);
  assert.match(broken.reason, /SSH host/);
});
