import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionScript, COMPLETION_COMMANDS, COMPLETION_SHELLS } from '../src/shell-completion.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'oasis-completion-'));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: join(home, 'cfg'), OASIS_NO_UPDATE_CHECK: '1', NO_COLOR: '1' } });
const has = (bin) => spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0;

test('oasis completion prints a script for every supported shell', () => {
  for (const shell of COMPLETION_SHELLS) {
    const result = run('completion', shell);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, completionScript(shell));
    for (const command of ['web', 'setup', 'doctor', 'mcp']) assert.ok(result.stdout.includes(command), shell + ' lists ' + command);
  }
  assert.equal(completionScript('pwsh'), completionScript('powershell'));
  assert.ok(Object.keys(COMPLETION_COMMANDS).includes('completion'));
});

test('oasis completion explains usage and rejects unknown shells', () => {
  const usage = run('completion');
  assert.equal(usage.status, 0);
  assert.match(usage.stdout, /Usage: oasis completion bash\|zsh\|fish\|powershell/);
  assert.match(usage.stdout, /eval "\$\(oasis completion bash\)"/);
  const bad = run('completion', 'tcsh');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown shell: tcsh/);
});

test('bash completion suggests commands, subcommands and permission modes', { skip: !has('bash') }, () => {
  const file = join(home, 'oasis.bash');
  writeFileSync(file, completionScript('bash'));
  const probe = (words, cword) => spawnSync('bash', ['-c', `source ${JSON.stringify(file)}; COMP_WORDS=(${words}); COMP_CWORD=${cword}; _oasis_complete; printf '%s\\n' "\${COMPREPLY[@]}"`], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepEqual(probe('oasis do', 1), ['doctor']);
  assert.ok(probe('oasis mcp l', 2).includes('list'));
  assert.deepEqual(probe('oasis --permission-mode a', 2), ['accept-edits', 'auto']);
  assert.ok(probe('oasis web --o', 2).includes('--open'));
});

test('zsh and fish completion scripts parse', { skip: !has('zsh') && !has('fish') }, () => {
  if (has('zsh')) { const f = join(home, 'oasis.zsh'); writeFileSync(f, completionScript('zsh')); assert.equal(spawnSync('zsh', ['-n', f]).status, 0); }
  if (has('fish')) { const f = join(home, 'oasis.fish'); writeFileSync(f, completionScript('fish')); assert.equal(spawnSync('fish', ['-n', f]).status, 0); }
});
