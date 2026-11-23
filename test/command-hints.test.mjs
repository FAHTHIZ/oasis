import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commandFlagWarning } from '../src/command-hints.mjs';
import { executePowerTool } from '../src/power-tools.mjs';

test('rg -r before the pattern is flagged; a deliberate replace is not', () => {
  assert.match(commandFlagWarning('rg -rn "foo" .'), /-r means --replace \(here it takes "n" as the replacement text/);
  assert.match(commandFlagWarning('cd src && rg -i -rn todo'), /--replace/);
  assert.match(commandFlagWarning('rg -nr foo .'), /--replace/);
  for (const command of ['rg foo -r bar', 'rg -n foo', 'rg --replace x foo', 'grep -rn foo .', 'git status']) assert.equal(commandFlagWarning(command), '', command);
});

test('macOS sed -i without a suffix is flagged only on darwin', () => {
  assert.match(commandFlagWarning("sed -i 's/a/b/' f.txt", 'darwin'), /macOS sed needs a backup suffix/);
  assert.equal(commandFlagWarning("sed -i 's/a/b/' f.txt", 'linux'), '');
  assert.equal(commandFlagWarning("sed -i '' 's/a/b/' f.txt", 'darwin'), '');
  assert.equal(commandFlagWarning("sed -i.bak 's/a/b/' f.txt", 'darwin'), '');
});

test('run_shell results carry the note', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-hints-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'hello\n');
  const result = await executePowerTool('run_shell', { command: 'rg -rn hello . || true' }, { root, autoApprove: true, approval: async () => true }, root);
  assert.equal(typeof result.exitCode, 'number');
  assert.match(result.commandWarning, /--replace/);
});

test('shell syntax in a run_command argument list is noted, not blocked', async () => {
  const { argvShellSyntaxWarning } = await import('../src/command-hints.mjs');
  assert.match(argvShellSyntaxWarning(['-', "<<'PY'", 'print(1)', 'PY']), /heredoc <<'PY'.*no script was fed to it on stdin/);
  assert.match(argvShellSyntaxWarning(['src', '|', 'wc', '-l']), /"\|" was passed to the program as a literal argument/);
  assert.match(argvShellSyntaxWarning(['test', '2>&1']), /"2>&1"/);
  assert.equal(argvShellSyntaxWarning(['--format=%h|%s']), '');
  assert.equal(argvShellSyntaxWarning(['-n', 'a|b', 'file']), '');
  assert.equal(argvShellSyntaxWarning(undefined), '');
});

test('run_command reports a heredoc it could not feed', async (t) => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { executeTool } = await import('../src/tools.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-argv-heredoc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await executeTool('run_command', { command: process.execPath, args: ['-', '<<JS', 'console.log(1)', 'JS'] }, { root, autoApprove: true });
  assert.equal(typeof result.exitCode, 'number');
  assert.match(result.commandWarning || '', /runs no shell/);
});
