import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { executeTool, nonInteractiveEnvironment } from '../src/tools.mjs';
import { executePowerTool } from '../src/power-tools.mjs';

test('nonInteractiveEnvironment disables pagers, editors and credential prompts', () => {
  const env = nonInteractiveEnvironment({ PATH: '/bin', EDITOR: 'vim' }, {});
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.PAGER, 'cat');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_EDITOR, 'true');
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  if (process.platform !== 'win32') assert.equal(env.EDITOR, 'true');
  assert.equal(nonInteractiveEnvironment({ GIT_SSH_COMMAND: 'ssh -i k' }, {}).GIT_SSH_COMMAND, 'ssh -i k');
  assert.deepEqual(nonInteractiveEnvironment({ A: '1' }, { OASIS_NONINTERACTIVE_ENV: '0' }), { A: '1' });
});

test('git commit without -m fails fast instead of waiting on an editor', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-nonint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  execFileSync('git', ['config', 'core.editor', 'sleep 60'], { cwd: root });
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  const env = { ...process.env, EDITOR: 'sleep 60', GIT_EDITOR: 'sleep 60' };
  const started = Date.now();
  const viaShell = await executePowerTool('run_shell', { command: 'git commit; echo "exit=$?"' }, { root, autoApprove: true, approval: async () => true, env }, root);
  assert.match(viaShell.stdout + viaShell.stderr, /empty commit message|exit=1/i);
  const viaCommand = await executeTool('run_command', { command: 'git', args: ['commit'] }, { root, autoApprove: true, approval: async () => true, env });
  assert.notEqual(viaCommand.exitCode, 0);
  assert.ok(Date.now() - started < 20000, 'should not wait for the editor');
});

test('write_file creates normal project files with umask permissions, secrets owner-only', { skip: process.platform === 'win32' }, async (t) => {
  const { stat } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { root, autoApprove: true, approval: async () => true, env: process.env };
  await executeTool('write_file', { path: 'public/index.html', content: '<p>hi</p>\n' }, ctx);
  await executeTool('write_file', { path: '.env.local', content: 'A=1\n' }, ctx).catch(() => {});
  const umask = process.umask();
  assert.equal((await stat(path.join(root, 'public/index.html'))).mode & 0o777, 0o666 & ~umask);
  const env = await stat(path.join(root, '.env.local')).catch(() => null);
  if (env) assert.equal(env.mode & 0o777, 0o600);
});

test('write_file flags unrequested summary documents', async (t) => {
  const { unrequestedDocWarning } = await import('../src/tools.mjs');
  assert.match(unrequestedDocWarning('FINAL_SUMMARY.md', 'fix the login bug'), /Unrequested document/);
  assert.match(unrequestedDocWarning('IMPLEMENTATION_NOTES.md', 'add oauth'), /Unrequested document/);
  assert.equal(unrequestedDocWarning('SUMMARY.md', 'put a summary in SUMMARY.md'), '');
  assert.equal(unrequestedDocWarning('docs/REPORT.md', 'write a report file'), '');
  assert.equal(unrequestedDocWarning('README.md', 'fix'), '');
  assert.equal(unrequestedDocWarning('notes.md', 'fix'), '');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-doc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = { currentRequest: 'fix the parser bug' };
  const result = await executeTool('write_file', { path: 'FIXES_SUMMARY.md', content: '# Fixes\n' }, { root, session, autoApprove: true, approval: async () => true, env: process.env });
  assert.match(result.warning, /Unrequested document: FIXES_SUMMARY\.md/);
});

test('write_file refuses to overwrite a file the agent only partly read', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n') + '\n';
  await writeFile(path.join(root, 'big.txt'), body);
  const ctx = { root, session: { config: {} }, autoApprove: true, approval: async () => true, env: process.env };
  await executeTool('read_file', { path: 'big.txt', offset: 1, limit: 50 }, ctx);
  await assert.rejects(executeTool('write_file', { path: 'big.txt', content: 'short\n' }, ctx), /Only part of big\.txt has been read \(lines 1-50 of 30\d\)/);
  await executeTool('read_file', { path: 'big.txt' }, ctx);
  await executeTool('read_file', { path: 'big.txt', offset: 10, limit: 5 }, ctx);
  const written = await executeTool('write_file', { path: 'big.txt', content: body.replace('line 0', 'first') }, ctx);
  assert.equal(written.backedUpExistingFile, true);
});
