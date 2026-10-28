import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import { analyzeCommand, PermissionPolicy, parseRule, ruleMatches, suggestRule } from '../src/permissions.mjs';
import { runWorkspaceCommand, executeTool } from '../src/tools.mjs';
import { grepWorkspace, multiEditFile, shellCommandBlocked } from '../src/power-tools.mjs';
import { detectSandbox, resolveSandbox, wrapCommand } from '../src/sandbox.mjs';

async function tmp(prefix = 'oasis-power-') { return await mkdtemp(path.join(os.tmpdir(), prefix)); }

test('command analysis blocks wrappers around blocked executables', () => {
  assert.match(analyzeCommand('env', ['rm', '-r', 'x']).blocked, /blocked/);
  assert.match(analyzeCommand('env', ['FOO=1', 'bash', '-c', 'x']).blocked, /blocked/);
  assert.match(analyzeCommand('xargs', ['-n', '1', 'rm']).blocked, /blocked/);
  assert.match(analyzeCommand('timeout', ['10', 'sudo', 'ls']).blocked, /blocked/);
  assert.match(analyzeCommand('nice', ['-n', '5', 'nohup', 'rm', 'x']).blocked, /blocked/);
  assert.match(analyzeCommand('/usr/bin/rm', ['x']).blocked, /blocked/);
  assert.match(analyzeCommand('RM.EXE', ['x']).blocked, /blocked/);
  assert.match(analyzeCommand('ksh', []).blocked, /blocked/);
  assert.match(analyzeCommand('git', ['clean', '-fdx']).blocked, /destructive Git/);
  assert.match(analyzeCommand('git', ['push', 'origin', '+main']).blocked, /destructive Git/);
  assert.match(analyzeCommand('pnpm', ['publish']).blocked, /Publishing/);
  assert.match(analyzeCommand('ls', ['rm -fr /']).blocked, /destructive/);
});

test('command analysis flags inline code and arbitrary-exec flags as high risk', () => {
  for (const [cmd, args] of [
    ['node', ['-e', 'x']], ['node', ['--eval=x']], ['python3', ['-c', 'x']], ['python3.12', ['-c', 'x']], ['python', ['-Bc', 'x']],
    ['perl', ['-e', 'x']], ['ruby', ['-e', 'x']], ['php', ['-r', 'x']], ['deno', ['eval', 'x']],
    ['find', ['.', '-delete']], ['find', ['.', '-exec', 'rm', '{}', ';']], ['awk', ['BEGIN{system("id")}']],
    ['git', ['-c', 'core.pager=evil', 'log']], ['git', ['checkout', '--', '.']], ['env', ['node', 'script.js']],
    ['curl', ['-o', 'x', 'https://e.com']], ['kill', ['-9', '1']]
  ]) {
    const result = analyzeCommand(cmd, args);
    assert.equal(result.blocked, undefined, cmd + ' should not be fully blocked');
    assert.ok(result.highRisk, cmd + ' ' + args.join(' ') + ' should be high risk');
  }
  for (const [cmd, args] of [['npm', ['test']], ['node', ['script.js']], ['python3', ['-m', 'pytest']], ['git', ['status']], ['find', ['.', '-name', '*.js']], ['curl', ['https://example.com']]]) {
    const result = analyzeCommand(cmd, args);
    assert.equal(result.blocked, undefined);
    assert.equal(result.highRisk, undefined, cmd + ' ' + args.join(' ') + ' should be normal risk');
  }
});

test('high-risk commands need interactive approval even with auto-approve', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompts = [];
  const denied = await runWorkspaceCommand(dir, process.execPath, ['-e', 'require("fs").writeFileSync("pwned", "1")'], {
    autoApprove: true,
    approval: async (message, force) => { prompts.push({ message, force }); return false; }
  });
  assert.equal(denied.approved, false);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].force, true);
  assert.match(prompts[0].message, /HIGH RISK/);
  await assert.rejects(access(path.join(dir, 'pwned')));
  // Without any approval callback a high-risk command never runs.
  const none = await runWorkspaceCommand(dir, process.execPath, ['-e', '1'], { autoApprove: true });
  assert.equal(none.approved, false);
  // An explicit allow rule is the user's decision and skips the prompt.
  const allowed = await runWorkspaceCommand(dir, process.execPath, ['-e', 'process.stdout.write("ok")'], { ruleAllowed: true });
  assert.equal(allowed.stdout, 'ok');
});

test('permission rules match commands, paths, domains, MCP prefixes, and Claude Code aliases', () => {
  assert.ok(ruleMatches(parseRule('run_command(npm test:*)'), 'run_command', { command: 'npm', args: ['test', '--', '--watch'] }));
  assert.ok(ruleMatches(parseRule('run_command(npm test:*)'), 'run_command', { command: 'npm', args: ['test'] }));
  assert.ok(!ruleMatches(parseRule('run_command(npm test:*)'), 'run_command', { command: 'npm', args: ['testing'] }));
  assert.ok(ruleMatches(parseRule('Bash(git status)'), 'run_command', { command: 'git', args: ['status'] }));
  assert.ok(!ruleMatches(parseRule('Bash(git status)'), 'run_command', { command: 'git', args: ['status', '-s'] }));
  assert.ok(ruleMatches(parseRule('Edit(src/**)'), 'edit_file', { path: 'src/a/b.js' }));
  assert.ok(ruleMatches(parseRule('Edit(src/**)'), 'multi_edit', { path: 'src/x.js' }));
  assert.ok(!ruleMatches(parseRule('Edit(src/**)'), 'edit_file', { path: 'test/x.js' }));
  assert.ok(ruleMatches(parseRule('WebFetch(domain:python.org)'), 'fetch_url', { url: 'https://docs.python.org/3/' }));
  assert.ok(!ruleMatches(parseRule('WebFetch(domain:python.org)'), 'fetch_url', { url: 'https://evilpython.org/' }));
  assert.ok(ruleMatches(parseRule('mcp_github'), 'mcp_github_create_issue', {}));
  const policy = new PermissionPolicy({ permissions: { allow: ['run_command(npm:*)'], ask: ['run_command(npm publish:*)'], deny: ['Read(secrets/**)'] } });
  assert.equal(policy.evaluate('run_command', { command: 'npm', args: ['test'] }).decision, 'allow');
  assert.equal(policy.evaluate('run_command', { command: 'npm', args: ['publish'] }).decision, 'ask');
  assert.equal(policy.evaluate('read_file', { path: 'secrets/a.txt' }).decision, 'deny');
  assert.equal(policy.evaluate('write_file', { path: 'a.txt' }).decision, 'default');
  policy.rememberForSession(suggestRule('run_command', { command: 'cargo', args: ['build', '--release'] }));
  assert.equal(policy.evaluate('run_command', { command: 'cargo', args: ['build'] }).decision, 'allow');
});

test('grep finds regex matches, honours globs and modes, and never returns secret files', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'a.js'), 'const alpha = 1;\nfunction betaFn() {}\n');
  await writeFile(path.join(dir, 'src', 'b.ts'), 'export const alphaBeta = 2;\n');
  await writeFile(path.join(dir, '.env'), 'alpha_SECRET=1\n');
  for (const forceFallback of [false, true]) {
    const content = await grepWorkspace(dir, { pattern: 'alpha\\w*' }, { forceFallback });
    assert.ok(content.results.some((line) => line.includes('src/a.js') && line.includes('alpha')), JSON.stringify(content));
    assert.ok(!content.results.some((line) => line.includes('.env')), 'secret leaked: ' + JSON.stringify(content));
    const files = await grepWorkspace(dir, { pattern: 'alpha', glob: '*.ts', output_mode: 'files_with_matches' }, { forceFallback });
    assert.deepEqual(files.results.map((r) => r.replace(/^\.\//, '')), ['src/b.ts']);
    const count = await grepWorkspace(dir, { pattern: 'ALPHA', ignore_case: true, output_mode: 'count' }, { forceFallback });
    assert.equal(count.results.length, 2);
  }
});

test('multi_edit applies all edits atomically or none', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.OASIS_CONFIG_DIR = path.join(dir, '.config');
  const file = path.join(dir, 'x.js');
  await writeFile(file, 'let a = 1;\nlet b = 2;\n');
  await assert.rejects(multiEditFile(dir, { path: 'x.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'missing', new_string: 'y' }] }), /not found/);
  assert.equal(await readFile(file, 'utf8'), 'let a = 1;\nlet b = 2;\n');
  const ok = await multiEditFile(dir, { path: 'x.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'a = 10;\nlet b', new_string: 'a = 10;\nconst b' }] });
  assert.equal(ok.changed, true);
  assert.equal(await readFile(file, 'utf8'), 'let a = 10;\nconst b = 2;\n');
  delete process.env.OASIS_CONFIG_DIR;
});

test('background commands start, stream output, and can be killed', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = { background: new Map() };
  await writeFile(path.join(dir, 'server.js'), 'console.log("ready"); setInterval(() => console.log("tick"), 50);');
  const started = await executeTool('run_command', { command: process.execPath, args: ['server.js'], run_in_background: true }, { root: dir, autoApprove: true, session });
  assert.equal(started.background, true);
  await new Promise((r) => setTimeout(r, 400));
  const out = await executeTool('command_output', { id: started.id }, { root: dir, session });
  assert.equal(out.status, 'running');
  assert.match(out.output, /ready/);
  const filtered = await executeTool('command_output', { id: started.id, filter: 'tick' }, { root: dir, session });
  assert.ok(!/ready/.test(filtered.output));
  const killed = await executeTool('kill_command', { id: started.id }, { root: dir, session });
  assert.equal(killed.killed, true);
  const list = await executeTool('list_background', {}, { root: dir, session });
  assert.equal(list.processes[0].status, 'killed');
});

test('shell guard blocks obviously destructive shell lines', () => {
  assert.ok(shellCommandBlocked('sudo apt install x'));
  assert.ok(shellCommandBlocked('rm -rf / --no-preserve-root'));
  assert.ok(shellCommandBlocked('rm -rf ~'));
  assert.ok(shellCommandBlocked('git push --force origin main'));
  assert.equal(shellCommandBlocked('npm test && npm run lint | tee out.txt'), null);
  assert.equal(shellCommandBlocked('rm -rf dist'), null);
});

test('OS sandbox confines writes to the workspace and blocks network when available', async (t) => {
  const probe = detectSandbox();
  if (!probe.available) { t.skip('No OS sandbox on this host: ' + probe.reason); return; }
  const dir = await tmp();
  const outside = await tmp('oasis-outside-');
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const sandbox = resolveSandbox({ sandbox: { enabled: true } }, dir);
  assert.equal(sandbox.available, true);
  const result = await runWorkspaceCommand(dir, process.execPath, ['writer.js'], { sandbox, approval: async () => true });
  // writer.js does not exist yet; ensure the wrapper still reports a normal failure.
  assert.notEqual(result.exitCode, 0);
  await writeFile(path.join(dir, 'writer.js'), 'const fs=require("fs");fs.writeFileSync("inside.txt","1");try{fs.writeFileSync(process.argv[2]+"/escape.txt","1");console.log("ESCAPED")}catch(e){console.log("CONFINED")}');
  const run = await runWorkspaceCommand(dir, process.execPath, ['writer.js', outside], { sandbox, approval: async () => true });
  assert.equal(run.sandboxed, sandbox.kind);
  assert.match(run.stdout, /CONFINED/);
  assert.equal(await readFile(path.join(dir, 'inside.txt'), 'utf8'), '1');
  await assert.rejects(access(path.join(outside, 'escape.txt')));
  const wrapped = wrapCommand('true', [], sandbox, dir);
  assert.ok(wrapped.args.includes('--unshare-net') || wrapped.args.join(' ').includes('deny network'));
});

test('session rules for path commands keep the path; deny rules also catch path forms', () => {
  const policy = new PermissionPolicy({ permissions: { deny: ['run_command(rm:*)'] } });
  const rule = suggestRule('run_command', { command: '/usr/local/bin/node', args: ['--version'] });
  assert.equal(rule, 'run_command(/usr/local/bin/node:*)');
  policy.rememberForSession(rule);
  assert.equal(policy.evaluate('run_command', { command: '/usr/local/bin/node', args: ['--version'] }).decision, 'allow');
  assert.notEqual(policy.evaluate('run_command', { command: '/tmp/evil/node', args: ['--version'] }).decision, 'allow');
  assert.equal(policy.evaluate('run_command', { command: '/bin/rm', args: ['-rf', 'x'] }).decision, 'deny');
});
