import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { expandInlineShell } from '../src/commands.mjs';
import { PermissionPolicy } from '../src/permissions.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-fenced-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const fence = '\u0060\u0060\u0060';

test('a ```! fenced block runs as one multi-line script and is replaced by its output', async (t) => {
  const root = await tmp(t);
  const text = '## Environment\n' + fence + '!\necho one\necho two\n' + fence + '\nDone.';
  const result = await expandInlineShell(text, { root, allowed: true });
  assert.equal(result.text, '## Environment\none\ntwo\nDone.');
  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].code, 0);
  // A plain code fence is left alone.
  const plain = fence + 'sh\necho nope\n' + fence;
  assert.equal((await expandInlineShell(plain, { root, allowed: true })).text, plain);
});

test('fenced blocks follow trust, deny rules and disableSkillShellExecution', async (t) => {
  const root = await tmp(t);
  const text = fence + '!\necho ok\nrm -rf build\n' + fence;
  const untrusted = await expandInlineShell(text, { root, allowed: false });
  assert.match(untrusted.text, /^\[skipped ```! block: project commands run shell only in trusted workspaces/);
  const policy = new PermissionPolicy({ permissions: { allow: [], ask: [], deny: ['Bash(rm:*)'], defaultMode: 'default' } });
  const denied = await expandInlineShell(text, { root, allowed: true, policy });
  assert.match(denied.text, /blocked by permission rule Bash\(rm:\*\)/);
  const off = await expandInlineShell(text, { root, allowed: true, disabledByPolicy: true });
  assert.equal(off.text, '[shell command execution disabled by policy]');
});

test('inline !`cmd` runs only at the start of a line or after whitespace', async (t) => {
  const root = await tmp(t);
  const result = await expandInlineShell('KEY=!`echo no`\n!`echo yes` and (x) !`echo also`', { root, allowed: true });
  assert.equal(result.text, 'KEY=!`echo no`\nyes and (x) also');
});
