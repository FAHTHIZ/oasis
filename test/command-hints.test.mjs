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
