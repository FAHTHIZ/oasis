import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maskedPipelineWarning, shellExitTarget } from '../src/pipe-status.mjs';
import { executeTool } from '../src/tools.mjs';

test('flags test and build commands whose status is hidden by a filter pipe', () => {
  for (const command of ['npm test | tail -20', 'npm run build 2>&1 | grep -v warn', 'pytest -q | tee out.txt', 'cd app && cargo test |& head', 'node --test test/*.mjs | tail -5', 'npx vitest run | cat']) {
    assert.match(maskedPipelineWarning(command, 0), /last pipe stage/, command);
  }
});

test('does not flag safe or unrelated pipelines', () => {
  for (const command of ['set -o pipefail; npm test | tail', 'npm test', 'ls | grep test', 'echo "npm test | tail"', 'npm test || echo failed', 'git log | head', 'npm test > out.txt']) {
    assert.equal(maskedPipelineWarning(command, 0), '', command);
  }
  assert.equal(maskedPipelineWarning('npm test | tail', 0, 'powershell'), '');
});

test('shellExitTarget finds the command that owns the exit status', () => {
  assert.deepEqual(shellExitTarget('cd app && CI=1 npm test'), { command: 'npm', args: ['test'], piped: false });
  assert.deepEqual(shellExitTarget('npm test | tail -3'), { command: 'npm', args: ['test'], piped: true });
  assert.deepEqual(shellExitTarget('set -o pipefail; npm test | tail -3'), { command: 'npm', args: ['test'], piped: false });
  assert.equal(shellExitTarget('echo $(npm test)'), null);
});

test('run_shell attaches exitCodeWarning when a failing test is piped through tail', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-pipe-'));
  try {
    await writeFile(path.join(root, 'failing.test.mjs'), "import test from 'node:test'; test('x', () => { throw new Error('boom'); });\n");
    const result = await executeTool('run_shell', { command: 'node --test failing.test.mjs | tail -3' }, { root, autoApprove: true, permissionMode: 'bypassPermissions' });
    assert.equal(result.exitCode, 0, 'the shell really reports 0 here');
    assert.match(result.exitCodeWarning || '', /not of `node --test failing\.test\.mjs`/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
