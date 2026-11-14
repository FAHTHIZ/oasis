// Unix sockets and the sandbox.network widening keys (Claude Code layout).
// A read-only bind mount does not stop connect() on a Unix socket, so without a filter a
// "no network" sandboxed command could drive /var/run/docker.sock or an SSH agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { loadSettings } from '../src/settings.mjs';
import { resolveSandbox, wrapCommand, macProfile, detectSandbox, unixSocketFilterPath } from '../src/sandbox.mjs';
import { srtConfig } from '../src/sandbox-runtime.mjs';

async function tmp(t, base = os.tmpdir()) {
  const dir = await realpath(await mkdtemp(path.join(base, 'oasis-sock-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t, { user, project, managed } = {}) {
  const root = await tmp(t);
  const home = await tmp(t);
  if (user) await writeFile(path.join(home, 'settings.json'), JSON.stringify(user));
  if (project) { await mkdir(path.join(root, '.claude'), { recursive: true }); await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(project)); }
  let managedFile = '';
  if (managed) { managedFile = path.join(home, 'managed.json'); await writeFile(managedFile, JSON.stringify(managed)); }
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: managedFile, OASIS_TRUST_WORKSPACE: '1' };
  return { root, home, env };
}

const WIDE = { allowUnixSockets: ['/var/run/docker.sock'], allowAllUnixSockets: true, allowLocalBinding: true, allowMachLookup: ['com.apple.CoreSimulator.*'], httpProxyPort: 8888, socksProxyPort: 1080 };

test('a repository cannot widen the sandbox with Unix-socket, binding or proxy keys', async (t) => {
  const s = await setup(t, { project: { sandbox: { enabled: true, network: WIDE } } });
  const settings = await loadSettings(s.root, { env: s.env });
  for (const key of Object.keys(WIDE)) assert.equal(settings.sandbox[key], undefined, key + ' from project settings is ignored');
  const sandbox = resolveSandbox(settings, s.root);
  assert.equal(sandbox.allowAllUnixSockets, false);
  assert.deepEqual(sandbox.allowUnixSockets, []);
  assert.equal(sandbox.httpProxyPort, undefined);
});

test('user settings set the widening keys and they reach the domain-filtering runtime', async (t) => {
  const s = await setup(t, { user: { sandbox: { enabled: true, network: { ...WIDE, allowUnixSockets: ['~/.docker/run/docker.sock', 'relative.sock', 7], httpProxyPort: 70000 } } } });
  const settings = await loadSettings(s.root, { env: s.env });
  assert.deepEqual(settings.sandbox.allowUnixSockets, [path.join(s.home, '.docker', 'run', 'docker.sock'), path.join(s.home, '.claude', 'relative.sock')]);
  assert.equal(settings.sandbox.allowAllUnixSockets, true);
  assert.equal(settings.sandbox.allowLocalBinding, true);
  assert.deepEqual(settings.sandbox.allowMachLookup, ['com.apple.CoreSimulator.*']);
  assert.equal(settings.sandbox.httpProxyPort, undefined, 'out-of-range port is skipped');
  assert.equal(settings.sandbox.socksProxyPort, 1080);
  const config = srtConfig({ ...resolveSandbox(settings, s.root), allowedDomains: ['github.com'], writable: [s.root] });
  assert.equal(config.network.allowAllUnixSockets, true);
  assert.equal(config.network.allowLocalBinding, true);
  assert.equal(config.network.socksProxyPort, 1080);
  assert.equal(config.network.httpProxyPort, undefined);
  assert.deepEqual(config.network.allowMachLookup, ['com.apple.CoreSimulator.*']);
});

test('a proxy port of your own selects the domain-filtering runtime', async (t) => {
  const s = await setup(t, { user: { sandbox: { enabled: true, network: { httpProxyPort: 3128 } } } });
  const sandbox = resolveSandbox(await loadSettings(s.root, { env: s.env }), s.root);
  assert.equal(sandbox.httpProxyPort, 3128);
  if (sandbox.available) assert.equal(sandbox.kind, 'srt');
});

test('under allowManagedDomainsOnly only managed settings can set a proxy port', async (t) => {
  const s = await setup(t, { user: { sandbox: { enabled: true, network: { httpProxyPort: 3128, socksProxyPort: 1080 } } }, managed: { sandbox: { network: { allowedDomains: ['corp.example'], allowManagedDomainsOnly: true, socksProxyPort: 9050 } } } });
  const sandbox = resolveSandbox(await loadSettings(s.root, { env: s.env }), s.root);
  assert.equal(sandbox.httpProxyPort, undefined);
  assert.equal(sandbox.socksProxyPort, 9050);
});

test('macOS profile refuses Unix sockets unless they are allowed', () => {
  const base = { writable: ['/repo'], network: false, maskedPaths: [], readOnlyPaths: [], protectedRoots: [] };
  const closed = macProfile(base);
  assert.doesNotMatch(closed, /\(allow network\* \(remote unix-socket\)\)/);
  assert.match(closed, /\(deny network-outbound \(remote unix-socket\)\)/);
  const one = macProfile({ ...base, allowUnixSockets: ['/var/run/docker.sock'] });
  assert.match(one, /\(allow network-outbound \(remote unix-socket \(subpath "\/var\/run\/docker\.sock"\)\)\)/);
  assert.match(macProfile({ ...base, allowAllUnixSockets: true }), /\(allow network-outbound \(remote unix-socket \(path-regex #"\^\/"\)\)\)/);
  assert.match(macProfile({ ...base, allowLocalBinding: true }), /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  // Rules after (deny network*) are what Seatbelt applies last.
  assert.ok(one.indexOf('(deny network*)') < one.indexOf('(allow network-outbound (remote unix-socket (subpath'));
});

test('bubblewrap: a sandboxed command cannot reach a host Unix socket unless allowAllUnixSockets is set', { skip: !detectSandbox().available || detectSandbox().kind !== 'bubblewrap' || !unixSocketFilterPath() || spawnSync('sh', ['-c', 'command -v python3'], { stdio: 'ignore' }).status !== 0 }, async (t) => {
  // The socket lives outside /tmp (which the sandbox replaces with a tmpfs), like /var/run/docker.sock.
  const sockDir = await tmp(t, os.homedir());
  const sock = path.join(sockDir, 'daemon.sock');
  const server = net.createServer((conn) => conn.end('reached-host-daemon\n'));
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  const root = await tmp(t, os.homedir());
  const client = 'import socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.connect(sys.argv[1])\nprint(s.recv(64).decode().strip())';
  const run = async (network) => {
    const sandbox = resolveSandbox({ sandbox: { enabled: true, writableCaches: false, ...(network ? { allowAllUnixSockets: true } : {}) } }, root);
    const wrapped = wrapCommand('python3', ['-c', client, sock], sandbox, root);
    const result = await new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const child = spawn(wrapped.command, wrapped.args, { cwd: root });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('close', (status) => resolve({ status, out }));
      });
    });
    if (wrapped.release) wrapped.release();
    return result;
  };
  const blocked = await run(false);
  assert.notEqual(blocked.status, 0, blocked.out);
  assert.doesNotMatch(blocked.out, /reached-host-daemon/);
  assert.match(blocked.out, /Operation not permitted|PermissionError/);
  const opened = await run(true);
  assert.equal(opened.status, 0, opened.out);
  assert.match(opened.out, /reached-host-daemon/);
});

test('bubblewrap: ordinary commands still run under the Unix-socket filter', { skip: !detectSandbox().available || detectSandbox().kind !== 'bubblewrap' || !unixSocketFilterPath() }, async (t) => {
  const root = await tmp(t);
  const sandbox = resolveSandbox({ sandbox: { enabled: true, writableCaches: false } }, root);
  assert.ok(sandbox.unixSocketFilter);
  const wrapped = wrapCommand(process.execPath, ['-e', 'require("fs").writeFileSync("ok.txt","1"); console.log("ran")'], sandbox, root);
  const result = spawnSync(wrapped.command, wrapped.args, { cwd: root, encoding: 'utf8' });
  if (wrapped.release) wrapped.release();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ran/);
});

test('a repository cannot reopen a path your own settings deny reading', async (t) => {
  const s = await setup(t, {
    user: { sandbox: { enabled: true, filesystem: { denyRead: ['~/.aws'] } } },
    project: { sandbox: { filesystem: { allowRead: ['~/.aws/credentials', '~/notes'], allowWrite: ['~/.aws'] } } }
  });
  const settings = await loadSettings(s.root, { env: s.env });
  assert.deepEqual(settings.sandbox.allowRead, [path.join(s.home, 'notes')]);
  assert.deepEqual(settings.sandbox.allowWrite || [], []);
  assert.equal(settings.sandbox.lockedRepoEntries.length, 2);
  assert.equal(settings.sandbox.adminRequired, undefined);
});

test('admin-required sandbox: repository loosening keys are ignored, your own still apply', async (t) => {
  const extra = await tmp(t);
  const s = await setup(t, {
    user: { sandbox: { enabled: true, failIfUnavailable: true, excludedCommands: ['make'] } },
    project: {
      permissions: { additionalDirectories: [extra] },
      sandbox: { enabled: false, failIfUnavailable: false, excludedCommands: ['docker *', 'make'], network: { allowedDomains: ['repo.example'], allowAllUnixSockets: true }, filesystem: { allowWrite: ['./out'] } }
    },
    managed: { sandbox: { allowUnsandboxedCommands: false } }
  });
  const settings = await loadSettings(s.root, { env: s.env });
  assert.equal(settings.sandbox.adminRequired, true);
  assert.equal(settings.sandbox.enabled, true, 'the repository cannot switch the sandbox off');
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.deepEqual(settings.sandbox.excludedCommands, ['make']);
  assert.deepEqual(settings.sandbox.allowedDomains, []);
  assert.deepEqual(settings.sandbox.allowWrite, []);
  assert.equal(settings.sandbox.allowAllUnixSockets, undefined);
  const sandbox = resolveSandbox(settings, s.root);
  assert.ok(!sandbox.writable.includes(extra), 'repository additionalDirectories are not writable by commands');
  assert.ok(settings.permissions.additionalDirectories.includes(extra), 'file tools still see the folder');
});

test('without an admin-required sandbox a trusted repository keeps its entries', async (t) => {
  const s = await setup(t, { project: { sandbox: { enabled: true, excludedCommands: ['docker *'], network: { allowedDomains: ['repo.example'] } } } });
  const settings = await loadSettings(s.root, { env: s.env });
  assert.equal(settings.sandbox.adminRequired, undefined);
  assert.deepEqual(settings.sandbox.excludedCommands, ['docker *']);
  assert.deepEqual(settings.sandbox.allowedDomains, ['repo.example']);
  // --settings with allowUnsandboxedCommands: false locks it, unless policy says true.
  const flagged = await loadSettings(s.root, { env: s.env, extraSettings: [{ settings: { sandbox: { allowUnsandboxedCommands: false } } }] });
  assert.equal(flagged.sandbox.adminRequired, true);
  assert.deepEqual(flagged.sandbox.excludedCommands, []);
});

test('doctor reports the configured sandbox backend, proxy port and admin-required lock', async (t) => {
  const { sandboxDoctor } = await import('../src/doctor.mjs');
  const s = await setup(t, { user: { sandbox: { enabled: true, backend: 'podman', network: { socksProxyPort: 1080 } } }, managed: { sandbox: { allowUnsandboxedCommands: false } } });
  const settings = await loadSettings(s.root, { env: s.env });
  const report = sandboxDoctor(settings, s.root, { env: s.env });
  const text = report.lines.join('\n');
  assert.doesNotMatch(text, /bubblewrap available/, 'a container backend is not reported as bubblewrap');
  assert.match(text, /Admin-required: yes/);
  if (report.status.available) assert.match(text, /container sandbox active \(podman/);
  else assert.ok(report.problems.some((p) => /enabled but unavailable/.test(p)));
  const os = sandboxDoctor({ ...settings, sandbox: { ...settings.sandbox, backend: 'os' } }, s.root, { env: s.env });
  assert.match(os.lines.join('\n'), /Network proxy: your own \(SOCKS :1080\)/);
});
