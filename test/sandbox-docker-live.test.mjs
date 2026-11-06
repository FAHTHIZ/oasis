// Live container-isolation checks against a real Docker engine.
// Opt-in: OASIS_LIVE_DOCKER=1 runs it when an engine responds; OASIS_REQUIRE_DOCKER=1 (the dedicated CI job) also fails if none does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSandbox, wrapCommand, detectContainerRuntime } from '../src/sandbox.mjs';

const required = process.env.OASIS_REQUIRE_DOCKER === '1';
const wanted = required || process.env.OASIS_LIVE_DOCKER === '1';
const probe = !wanted ? { available: false, reason: 'set OASIS_LIVE_DOCKER=1 to run live container checks' } : process.platform === 'linux' ? detectContainerRuntime('docker', true) : { available: false, reason: 'live container checks run on Linux runners' };
const skip = probe.available || required ? false : (wanted ? 'Docker engine not available: ' + probe.reason : probe.reason);

function run(sandbox, cwd, script) {
  const launch = wrapCommand('sh', ['-c', script], sandbox, cwd);
  return spawnSync(launch.command, launch.args, { encoding: 'utf8', timeout: 180000 });
}

test('live docker sandbox: workspace writable, host untouched, no network, no capabilities, no host secrets', { skip, timeout: 600000 }, async (t) => {
  assert.ok(probe.available, 'OASIS_REQUIRE_DOCKER=1 but the Docker engine is unavailable: ' + probe.reason);
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-docker-live-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'host-only');

  const sandbox = resolveSandbox({ sandbox: { enabled: true, backend: 'docker', network: false } }, root, true);
  assert.equal(sandbox.kind, 'docker');
  assert.deepEqual(sandbox.writable, [root], 'only the workspace is mounted');

  const pull = spawnSync('docker', ['pull', '-q', sandbox.image], { encoding: 'utf8', timeout: 300000 });
  assert.equal(pull.status, 0, 'image pull failed: ' + pull.stderr);

  // A workspace may itself be the user's home or contain a path that was
  // explicitly classified as sensitive. A container must overlay that path
  // after the broad workspace mount instead of exposing its host contents.
  const hostCredentialDir = path.join(root, '.ssh');
  await mkdir(hostCredentialDir);
  const hostCredential = path.join(hostCredentialDir, 'id_ed25519');
  await writeFile(hostCredential, 'host-private-key-fixture');
  const hostCredentialFile = path.join(root, '.netrc');
  await writeFile(hostCredentialFile, 'machine private.example login fixture password host-file-secret');
  const maskedSandbox = {
    ...sandbox,
    maskedPaths: [
      { path: hostCredentialDir, type: 'directory' },
      { path: hostCredentialFile, type: 'file' }
    ]
  };
  const masked = run(maskedSandbox, root, [
    'if test -r .ssh/id_ed25519; then cat .ssh/id_ed25519; else echo DIRECTORY_MASKED; fi',
    'if test -s .netrc; then cat .netrc; else echo FILE_MASKED; fi'
  ].join('; '));
  assert.equal(masked.status, 0, masked.stderr);
  assert.match(masked.stdout, /DIRECTORY_MASKED/);
  assert.match(masked.stdout, /FILE_MASKED/);
  assert.doesNotMatch(masked.stdout, /host-private-key-fixture|host-file-secret/);
  assert.equal((await readFile(hostCredential, 'utf8')), 'host-private-key-fixture', 'directory masking must not alter the host secret');
  assert.equal((await readFile(hostCredentialFile, 'utf8')), 'machine private.example login fixture password host-file-secret', 'file masking must not alter the host secret');

  // 1. The workspace is mounted read-write at its host path and files keep the host user's ownership.
  const write = run(sandbox, root, 'echo from-container > made-inside.txt && pwd');
  assert.equal(write.status, 0, write.stderr);
  assert.equal(write.stdout.trim(), root);
  assert.equal((await readFile(path.join(root, 'made-inside.txt'), 'utf8')).trim(), 'from-container');

  // 2. Paths outside the workspace are not mounted: the host file is invisible and writes there never reach the host.
  const escape = run(sandbox, root, 'cat ' + JSON.stringify(path.join(outside, 'secret.txt')) + ' 2>/dev/null && echo LEAK; mkdir -p ' + JSON.stringify(outside) + ' 2>/dev/null; echo x > ' + JSON.stringify(path.join(outside, 'planted.txt')) + ' 2>/dev/null; echo done');
  assert.doesNotMatch(escape.stdout, /LEAK|host-only/, 'host file outside the workspace was readable');
  assert.equal(existsSync(path.join(outside, 'planted.txt')), false, 'a write outside the workspace reached the host');

  // 3. Network is off by default: only the loopback interface exists and outbound connections fail.
  const net = run(sandbox, root, 'ls /sys/class/net; node -e "require(\'net\').connect(53,\'1.1.1.1\').on(\'connect\',()=>{console.log(\'ONLINE\');process.exit(0)}).on(\'error\',e=>{console.log(\'OFFLINE \'+e.code);process.exit(0)});setTimeout(()=>{console.log(\'OFFLINE timeout\');process.exit(0)},5000)"');
  assert.equal(net.status, 0, net.stderr);
  assert.deepEqual(net.stdout.split('\n').filter((l) => l && !l.startsWith('OFFLINE') && !l.startsWith('ONLINE')), ['lo']);
  assert.match(net.stdout, /OFFLINE/);
  assert.doesNotMatch(net.stdout, /ONLINE/);

  // 4. Every Linux capability is dropped and privilege escalation is disabled.
  const caps = run(sandbox, root, 'grep -E "^(CapEff|CapBnd|NoNewPrivs)" /proc/self/status');
  assert.equal(caps.status, 0, caps.stderr);
  assert.match(caps.stdout, /CapEff:\s+0{16}/);
  assert.match(caps.stdout, /CapBnd:\s+0{16}/);
  assert.match(caps.stdout, /NoNewPrivs:\s+1/);

  // 5. The runtime does not run as root and sees a scratch HOME, not the host user's home.
  const who = run(sandbox, root, 'id -u; echo $HOME; ls -A $HOME | wc -l; test -e ' + JSON.stringify(path.join(os.homedir(), '.ssh')) + ' && echo HOST_SSH || echo no-host-ssh');
  assert.equal(who.status, 0, who.stderr);
  const [uid, home, , ssh] = who.stdout.trim().split('\n');
  assert.equal(uid, String(process.getuid()));
  assert.notEqual(uid, '0');
  assert.equal(home, '/tmp');
  assert.equal(ssh, 'no-host-ssh');

  // 6. The process limit holds, so a fork bomb cannot exhaust the host.
  const pids = run(sandbox, root, 'cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max');
  assert.equal(pids.stdout.trim(), '512');
});
