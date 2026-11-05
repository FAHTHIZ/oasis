import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { readOnlyArgv, readOnlyShellLine, readOnlyCommandsEnabled, readOnlyGitEnv } from '../src/read-only-commands.mjs';
import { runWorkspaceCommand } from '../src/tools.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-ro-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  return root;
}

test('plain read-only commands inside the workspace need no prompt', async (t) => {
  const root = await workspace(t);
  for (const [command, args] of [
    ['ls', ['-la']], ['cat', ['src/a.js']], ['grep', ['-rn', 'export', 'src']], ['rg', ['-n', 'a', 'src']], ['wc', ['-l', 'src/a.js']],
    ['find', ['.', '-name', '*.js']], ['head', ['-20', 'src/a.js']], ['git', ['status', '--short']], ['git', ['diff', 'HEAD~1', '--', 'src']],
    ['git', ['log', '--oneline', '-5']], ['git', ['show', 'HEAD:src/a.js']], ['git', ['branch', '-a']], ['git', ['--no-pager', 'log', '-1']],
    ['node', ['--version']], ['npm', ['ls']], ['pwd', []]
  ]) assert.equal(readOnlyArgv(command, args, { root }), true, command + ' ' + args.join(' '));
});

test('anything that writes, runs code, leaves the workspace or reads secrets still asks', async (t) => {
  const root = await workspace(t);
  await symlink(os.homedir(), path.join(root, 'home-link')).catch(() => {});
  for (const [command, args] of [
    ['npm', ['test']], ['node', ['script.js']], ['find', ['.', '-delete']], ['find', ['.', '-exec', 'rm', '{}', ';']], ['sort', ['-o', 'out', 'a']],
    ['rg', ['--pre', 'sh', 'x']], ['cat', ['/etc/passwd']], ['cat', ['../outside']], ['cat', ['~/.ssh/id_rsa']], ['cat', ['.env']],
    ['cat', ['home-link/.bashrc']], ['git', ['commit', '-m', 'x']], ['git', ['push']], ['git', ['branch', 'new']], ['git', ['tag', 'v1']],
    ['git', ['-C', '/', 'status']], ['git', ['diff', '--output=x']], ['git', ['diff', '--ext-diff']], ['git', ['config', 'user.name', 'x']],
    ['git', ['stash']], ['sed', ['-i', 's/a/b/', 'src/a.js']], ['awk', ['{print}', 'src/a.js']], ['rm', ['src/a.js']], ['/bin/ls', []],
    ['uniq', ['in', 'out']], ['date', ['-s', 'now']], ['tree', ['-o', 'out']]
  ]) assert.equal(readOnlyArgv(command, args, { root }), false, command + ' ' + args.join(' '));
});

test('shell lines: each command must be read-only, no expansion or redirection, cd stays inside', async (t) => {
  const root = await workspace(t);
  for (const line of ['ls src && git status', 'git log --oneline -5 | head -3', 'grep -rn export src 2>/dev/null', 'cd src && ls', 'git diff --stat; git status --short', 'cat src/a.js 2>&1 | wc -l'])
    assert.equal(readOnlyShellLine(line, { root }), true, line);
  for (const line of ['ls > out.txt', 'cat $HOME/.ssh/id_rsa', 'echo $(rm -rf x)', 'ls `pwd`', 'cd .. && ls', 'cd .. && cat secret', 'ls & sleep 1', 'FOO=1 ls',
    'sudo ls', 'xargs rm < list', 'git status && npm test', 'cat .env', 'env', 'ls ~', 'find . -delete', '(ls)', 'ls src\nrm -rf src'])
    assert.equal(readOnlyShellLine(line, { root }), false, line);
});

test('it can be turned off, and auto-run git never starts fsmonitor or a pager', () => {
  assert.equal(readOnlyCommandsEnabled({}, {}), true);
  assert.equal(readOnlyCommandsEnabled({ OASIS_READ_ONLY_COMMANDS: '0' }, {}), false);
  assert.equal(readOnlyCommandsEnabled({}, { permissions: { readOnlyCommands: false } }), false);
  const env = readOnlyGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' });
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.fsmonitor');
  assert.equal(env.GIT_CONFIG_VALUE_1, 'false');
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
});

test('run_command runs a read-only command without calling approval, and still asks for others', async (t) => {
  const root = await workspace(t);
  let asked = 0;
  const approval = async () => { asked++; return false; };
  const ls = await runWorkspaceCommand(root, 'ls', ['src'], { approval, env: process.env });
  assert.equal(asked, 0);
  assert.equal(ls.exitCode, 0);
  assert.match(ls.stdout, /a\.js/);
  const node = await runWorkspaceCommand(root, 'node', ['-e', '1'], { approval, env: process.env });
  assert.equal(asked, 1);
  assert.equal(node.approved, false);
  const off = await runWorkspaceCommand(root, 'ls', ['src'], { approval, env: process.env, readOnlyCommands: false });
  assert.equal(asked, 2);
  assert.equal(off.approved, false);
});
