import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { wrapCommand, macProfile, containerArgs, protectedWritePaths, detectSandbox } from '../src/sandbox.mjs';
import { executePowerTool } from '../src/power-tools.mjs';

function project(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'oasis-protect-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  mkdirSync(path.join(root, '.oasis'));
  return root;
}

test('protected paths are planned for existing and missing git, settings and editor files', (t) => {
  const root = project(t);
  const plan = protectedWritePaths([root]);
  const existing = plan.existing.map((item) => path.relative(root, item.path)).sort();
  assert.deepEqual(existing, ['.git/config', '.git/hooks', '.oasis/commands', '.oasis/agents', '.oasis/skills', '.oasis/hooks'].filter((rel) => existsSync(path.join(root, rel))).sort());
  const missing = plan.missing.map((item) => path.relative(root, item.path) + ':' + item.type).sort();
  assert.ok(missing.includes('.mcp.json:file'));
  assert.ok(missing.includes('.oasis/settings.json:file'));
  assert.ok(missing.includes('.claude:directory'), 'a missing .claude folder is covered as a whole');
  assert.ok(missing.includes('.vscode:directory'));
  assert.ok(!missing.some((item) => item.startsWith('.bashrc')), 'missing rc files get no placeholder');
});

test('worktree .git files are protected instead of .git/hooks', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'oasis-protect-wt-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');
  const plan = protectedWritePaths([root]);
  assert.ok(plan.existing.some((item) => item.path === path.join(root, '.git') && item.type === 'file'));
  assert.ok(!plan.missing.some((item) => item.path.startsWith(path.join(root, '.git') + path.sep)));
});

test('macOS profile denies writes to protected paths after the workspace allow rule', (t) => {
  const root = project(t);
  const profile = macProfile({ writable: [root], protectedRoots: [root], maskedPaths: [] });
  const allowAt = profile.indexOf('(allow file-write*');
  for (const rel of ['.git/hooks', '.git/config', '.mcp.json', '.oasis/settings.json', '.vscode', '.claude/commands']) {
    const at = profile.indexOf(JSON.stringify(path.join(root, rel)));
    assert.ok(at > allowAt, rel + ' must be denied after the allow rule');
  }
});

test('containers mount existing protected paths read-only', (t) => {
  const root = project(t);
  const args = containerArgs('true', [], { kind: 'docker', writable: [root], protectedRoots: [root] }, root, 'linux');
  assert.ok(args.includes(path.join(root, '.git', 'hooks') + ':' + path.join(root, '.git', 'hooks') + ':ro'));
  assert.ok(args.includes(path.join(root, '.git', 'config') + ':' + path.join(root, '.git', 'config') + ':ro'));
});

const bwrap = process.platform === 'linux' && detectSandbox(true).kind === 'bubblewrap';

test('bubblewrap blocks writes to protected paths and removes its placeholders', { skip: !bwrap && 'bubblewrap is not available' }, (t) => {
  const root = project(t);
  const sandbox = { enabled: true, available: true, kind: 'bubblewrap', writable: [root], protectedRoots: [root], maskedPaths: [], network: false };
  const script = [
    'echo evil >> .git/hooks/pre-commit', 'echo evil >> .git/config', "echo '{}' > .mcp.json", "echo '{}' > .oasis/settings.json",
    'mkdir -p .vscode && echo x > .vscode/tasks.json', 'mkdir -p .claude/commands && echo x > .claude/commands/a.md',
    'echo ok > normal.txt', 'mkdir -p src && echo ok > src/a.js', 'true'
  ].join('; ');
  const launch = wrapCommand('/bin/sh', ['-c', script], sandbox, root);
  const result = spawnSync(launch.command, launch.args, { cwd: root, encoding: 'utf8' });
  launch.release();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(root, 'normal.txt'), 'utf8'), 'ok\n');
  assert.equal(readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'ok\n');
  assert.equal(readFileSync(path.join(root, '.git', 'config'), 'utf8'), '[core]\n');
  assert.deepEqual(readdirSync(path.join(root, '.git', 'hooks')), []);
  for (const rel of ['.mcp.json', '.oasis/settings.json', '.vscode', '.claude']) assert.ok(!existsSync(path.join(root, rel)), rel + ' placeholder must be gone');
});

test('run_shell through the sandbox cleans up placeholders when the command ends', { skip: !bwrap && 'bubblewrap is not available' }, async (t) => {
  const root = project(t);
  const sandbox = { enabled: true, available: true, kind: 'bubblewrap', writable: [root], protectedRoots: [root], maskedPaths: [], network: false, autoAllowShellCommands: true };
  const result = await executePowerTool('run_shell', { command: "echo '{}' > .mcp.json; echo done" }, { sandbox, approval: async () => true, env: process.env }, root);
  assert.match(String(result.stdout || result.output || JSON.stringify(result)), /done/);
  assert.ok(!existsSync(path.join(root, '.mcp.json')));
});
