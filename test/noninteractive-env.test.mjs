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
