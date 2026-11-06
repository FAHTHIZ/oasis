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

test('globs, recursive searches and git object paths cannot reach secret files without asking', async (t) => {
  // Regression: `cat .en?` and `grep -r KEY .` printed .env with no prompt, because
  // the shell expands globs after the check and recursive searches read every file.
  const root = await workspace(t);
  await mkdir(path.join(root, 'keys'));
  await writeFile(path.join(root, 'keys', 'deploy.pem'), 'PRIVATE\n');
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'a.md'), 'x\n');
  for (const line of ['cat .en?', 'cat .env*', 'head .[e]nv', 'tail .??v', 'wc -c .e*', 'grep -r SECRET .', 'grep -rn SECRET', 'grep --recursive SECRET .',
    'egrep -d recurse SECRET .', 'rg --hidden SECRET', 'rg -uu SECRET .', 'rg PRIVATE', 'rg PRIVATE keys', 'diff -r . docs', 'git show HEAD:.env', 'git cat-file -p HEAD:keys/deploy.pem',
    'git grep --untracked SECRET', 'git grep --no-index SECRET', 'cat *.pem keys/*', 'cat keys/*', 'ls ../*', 'cat [k]eys/*.pem', '* --version', 'cat /etc/*'])
    assert.equal(readOnlyShellLine(line, { root }), false, line);
  for (const line of ['grep -rn export src', 'grep -rn -A 3 export src', 'rg export src', "grep -rn 'a.*b' src", 'rg -n "x?" docs', 'git grep export', 'git show HEAD:src/a.js', 'find . -name "*.js"'])
    assert.equal(readOnlyShellLine(line, { root }), true, line);
  await rm(path.join(root, 'keys'), { recursive: true });
  assert.equal(readOnlyShellLine('rg SECRET', { root }), true, 'rg skips the hidden .env by default');
  assert.equal(readOnlyArgv('grep', ['-r', 'SECRET', '.'], { root }), false, 'run_command argv path too');
  await symlink(os.homedir(), path.join(root, 'docs', 'home-link')).catch(() => {});
  assert.equal(readOnlyShellLine('grep -R x docs', { root }), false, 'followed symlinks can leave the workspace');
  assert.equal(readOnlyShellLine('grep -r x docs', { root }), true, 'grep -r does not follow symlinks');
});

test('run_shell asks before a glob that expands to .env', { skip: process.platform === 'win32' }, async (t) => {
  const root = await workspace(t);
  const { executePowerTool } = await import('../src/power-tools.mjs');
  const prompts = [];
  const result = await executePowerTool('run_shell', { command: 'cat .en?' }, { root, approval: async (message) => { prompts.push(message); return false; }, env: process.env }, root);
  assert.equal(prompts.length, 1);
  assert.equal(result.approved, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET=1/);
});

test('read-only git asks when the repository config names diff, filter or gpg programs', { skip: process.platform === 'win32' }, async (t) => {
  // Regression: git diff/status/log -p/cat-file --filters ran diff.external,
  // textconv and clean/smudge drivers from .git/config without any prompt.
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const root = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'a@example.com'); git('config', 'user.name', 'a');
  await writeFile(path.join(root, '.gitattributes'), '*.bin diff=evil filter=evil\n');
  await writeFile(path.join(root, 'b.bin'), '1\n');
  git('add', 'src', 'b.bin', '.gitattributes'); git('commit', '-qm', 'x');
  await writeFile(path.join(root, 'b.bin'), '2\n');
  assert.equal(readOnlyArgv('git', ['diff'], { root }), true, 'a plain repository still runs without asking');
  const marker = (name) => path.join(root, 'ran-' + name);
  git('config', 'diff.external', 'sh -c "touch ' + marker('external') + '"');
  git('config', 'diff.evil.textconv', 'sh -c "touch ' + marker('textconv') + '; cat \\"$1\\"" -');
  git('config', 'filter.evil.clean', 'sh -c "touch ' + marker('clean') + '; cat"');
  git('config', 'filter.evil.smudge', 'sh -c "touch ' + marker('smudge') + '; cat"');
  let asked = 0;
  const approval = async () => { asked++; return false; };
  const calls = [['status'], ['diff'], ['log', '-p', '-1'], ['show', 'HEAD'], ['cat-file', '--filters', 'HEAD:b.bin'], ['blame', 'b.bin']];
  for (const args of calls) await runWorkspaceCommand(root, 'git', args, { approval, env: process.env });
  assert.equal(asked, calls.length);
  for (const name of ['external', 'textconv', 'clean', 'smudge']) assert.equal(existsSync(marker(name)), false, name + ' driver ran');
  assert.equal(readOnlyShellLine('git status', { root }), false);
  // The git_status/git_diff tools run without a prompt too; they switch the filters off.
  const { executeTool } = await import('../src/tools.mjs');
  const { rm: remove } = await import('node:fs/promises');
  for (const name of ['clean', 'smudge']) await remove(marker(name), { force: true });
  for (const tool of ['git_status', 'git_diff']) {
    await writeFile(path.join(root, 'b.bin'), tool + '\n');
    const result = await executeTool(tool, {}, { root, env: process.env, approval });
    assert.equal(existsSync(marker('clean')), false, tool + ' ran the clean filter');
    if (tool === 'git_diff') assert.match(JSON.stringify(result), /b\.bin/);
  }
});

test('direnv, PostgreSQL, MySQL, htpasswd and legacy Docker credential files are secret', async (t) => {
  // Regression: read_file and the read-only shell path returned these with no prompt.
  const { sensitivePath } = await import('../src/tools.mjs');
  const root = await workspace(t);
  for (const name of ['.envrc', '.pgpass', '.my.cnf', '.htpasswd', '.dockercfg']) {
    await writeFile(path.join(root, name), 'pw\n');
    assert.equal(sensitivePath(name), true, name);
    assert.equal(sensitivePath('sub/' + name.toUpperCase()), true, name);
    assert.equal(readOnlyShellLine('cat ' + name, { root }), false, name);
  }
  assert.equal(sensitivePath('src/envrc.js'), false);
});

test('service-account keys and Terraform state are secret', async (t) => {
  // Regression: these hold cloud credentials in plain text and were read with no prompt.
  const { sensitivePath } = await import('../src/tools.mjs');
  const root = await workspace(t);
  for (const name of ['service-account.json', 'service_account-prod.json', 'terraform.tfstate', 'terraform.tfstate.backup']) {
    await writeFile(path.join(root, name), '{}\n');
    assert.equal(sensitivePath('infra/' + name), true, name);
    assert.equal(readOnlyShellLine('cat ' + name, { root }), false, name);
  }
  assert.equal(readOnlyShellLine('cat terraform.tf*', { root }), false, 'glob reaching tfstate');
  assert.equal(sensitivePath('src/service-accounts.js'), false);
  assert.equal(sensitivePath('main.tf'), false);
});

test('benign globs are expanded and checked like typed paths', { skip: process.platform === 'win32' }, async (t) => {
  // Globs used to make every line ask, which denied ls src/*.js in headless runs.
  const root = await workspace(t);
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'test', 'a.test.mjs'), 'x\n');
  await writeFile(path.join(root, 'test', 'b.test.mjs'), 'y\n');
  await writeFile(path.join(root, 'package.json'), '{}\n');
  for (const line of ['ls src/*.js', 'wc -l test/*.mjs', 'cat *.json', 'ls */', 'ls *', 'head -n 3 test/[ab].test.mjs', 'ls nothing-*.txt', "grep -n 'x' test/*.mjs", 'ls src/?.js', 'cd src && ls *.js'])
    assert.equal(readOnlyShellLine(line, { root }), true, line);
  for (const line of ['cat .en?', 'head .[e]nv', 'wc -c .e*', 'cat .*', 'ls .e*'])
    assert.equal(readOnlyShellLine(line, { root }), false, line);
  // A symlinked folder pointing outside the workspace is not expanded.
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-glob-out-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'x.txt'), 'outside\n');
  await symlink(outside, path.join(root, 'out'));
  assert.equal(readOnlyShellLine('cat out/*.txt', { root }), false);
  assert.equal(readOnlyShellLine('cat */x.txt', { root }), false);
  // Quoted and escaped wildcards are literal text, not globs.
  assert.equal(readOnlyShellLine("grep -rn 'a.*b' src", { root }), true);
  assert.equal(readOnlyShellLine('ls src/\\*.js', { root }), true);
  assert.equal(readOnlyShellLine('ls src/[z-a].js', { root }), false, 'an invalid class asks instead of throwing');
});

test('read-only git asks when a checked-out submodule config names a filter', { skip: process.platform === 'win32' }, async (t) => {
  // Regression: git status in the outer repository ran the clean filter from
  // the submodule's own .git/modules/<name>/config with no prompt.
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const base = await workspace(t);
  const inner = path.join(base, 'inner');
  const root = path.join(base, 'outer');
  await mkdir(inner); await mkdir(root);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'ignore' });
  await writeFile(path.join(inner, '.gitattributes'), '*.txt filter=evil\n');
  await writeFile(path.join(inner, 'a.txt'), '1\n');
  git(inner, 'init', '-q'); git(inner, 'add', '.'); git(inner, 'commit', '-qm', 'i');
  git(root, 'init', '-q'); git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'); git(root, 'commit', '-qm', 's');
  assert.equal(readOnlyArgv('git', ['status'], { root }), true, 'a plain submodule still runs without asking');
  const marker = path.join(base, 'ran-clean');
  git(path.join(root, 'sub'), 'config', 'filter.evil.clean', 'sh -c "touch ' + marker + '; cat"');
  await writeFile(path.join(root, 'sub', 'a.txt'), '2\n');
  assert.equal(readOnlyArgv('git', ['status'], { root }), false);
  assert.equal(readOnlyShellLine('git diff', { root }), false);
  const { executeTool } = await import('../src/tools.mjs');
  await executeTool('git_status', {}, { root, env, approval: async () => false });
  assert.equal(existsSync(marker), false, 'git_status ran the submodule filter');
});
