import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveSandbox, domainList, wrapCommand } from '../src/sandbox.mjs';
import { runWorkspaceCommand } from '../src/tools.mjs';
import { sandboxRuntimeState, srtConfig } from '../src/sandbox-runtime.mjs';

test('allowedDomains selects the domain-filtering backend and validates entries', async () => {
  assert.deepEqual(domainList(['Example.com', '*.npmjs.org', 'host:8080', 'bad domain', 'a;b', 7, 'example.com']), ['example.com', '*.npmjs.org', 'host:8080']);
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'oasis-srt-')));
  try {
    const plain = resolveSandbox({ sandbox: { enabled: true } }, root, true);
    assert.notEqual(plain.kind, 'srt');
    const filtered = resolveSandbox({ sandbox: { enabled: true, allowedDomains: ['example.com'], deniedDomains: ['evil.example.com'] } }, root, true);
    assert.deepEqual(filtered.allowedDomains, ['example.com']);
    if (filtered.available) {
      assert.equal(filtered.kind, 'srt');
      assert.throws(() => wrapCommand('true', [], filtered, root), /launchCommand/);
    } else assert.match(filtered.reason, /bubblewrap|Linux or macOS|sandbox-exec/);
    const config = srtConfig(filtered);
    assert.deepEqual(config.network, { allowedDomains: ['example.com'], deniedDomains: ['evil.example.com'] });
    assert.ok(config.filesystem.allowWrite.includes(root));
    // Containers and SSH keep their own network switch.
    assert.equal(resolveSandbox({ sandbox: { enabled: true, backend: 'docker', allowedDomains: ['example.com'] } }, root, true).allowedDomains, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const usable = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v bwrap && command -v socat && command -v curl && bwrap --ro-bind / / true'], { stdio: 'ignore' }).status === 0;

test('commands under allowedDomains reach only listed hosts and cannot write outside the workspace', { skip: usable ? false : 'needs bubblewrap, socat and curl on Linux' }, async () => {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'oasis-srt-')));
  const outside = path.join(os.homedir(), 'oasis-srt-outside-' + process.pid);
  try {
    const sandbox = resolveSandbox({ sandbox: { enabled: true, allowedDomains: ['example.com'] } }, root, true);
    assert.equal(sandbox.kind, 'srt');
    const blocked = await runWorkspaceCommand(root, 'curl', ['-sS', '--max-time', '10', '-o', '/dev/null', '-w', '%{http_code}', 'https://blocked.invalid/'], { sandbox, autoApprove: true, approval: async () => true, persistOutputLogs: false });
    assert.equal(blocked.approved, true);
    assert.equal(typeof blocked.exitCode, 'number', 'curl ran');
    assert.notEqual(blocked.exitCode, 0, 'a host outside the list is refused');
    assert.match(blocked.stdout, /^(000|403)$/);
    const script = "const fs = require('fs'); fs.writeFileSync('in.txt', 'inside'); fs.writeFileSync(" + JSON.stringify(outside) + ", 'x');";
    const write = await runWorkspaceCommand(root, process.execPath, ['-e', script], { sandbox, autoApprove: true, approval: async () => true, persistOutputLogs: false });
    assert.ok(existsSync(path.join(root, 'in.txt')));
    assert.equal(existsSync(outside), false);
    assert.equal(typeof write.exitCode, 'number');
    assert.notEqual(write.exitCode, 0);
    // The in-process proxy is released once no command holds it.
    const deadline = Date.now() + 3000;
    while (sandboxRuntimeState().running && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(sandboxRuntimeState(), { running: false, active: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
