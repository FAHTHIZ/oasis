import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { suggestRule } from '../src/permissions.mjs';
import { runWorkspaceCommand } from '../src/tools.mjs';

test('one-click session rules for interpreters name what ran, and never inline code', () => {
  assert.equal(suggestRule('run_command', { command: 'node', args: ['--test', 'cart.test.js'] }), 'run_command(node --test:*)');
  assert.equal(suggestRule('run_command', { command: 'python3', args: ['app.py'] }), 'run_command(python3 app.py:*)');
  assert.equal(suggestRule('run_command', { command: 'node', args: ['-e', '1'] }), null);
  assert.equal(suggestRule('run_command', { command: 'node', args: ['--test', '--import', 'x.mjs'] }), null);
  assert.equal(suggestRule('run_command', { command: 'node' }), null);
  assert.equal(suggestRule('run_shell', { command: 'python3 -c "print(1)"' }), null);
  assert.equal(suggestRule('run_shell', { command: 'node --test' }), 'run_shell(node --test:*)');
  assert.equal(suggestRule('run_command', { command: 'npm', args: ['test'] }), 'run_command(npm test:*)');
});

test('a session rule does not wave through a high-risk command; a settings rule still does', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-session-rule-'));
  let asked = 0;
  const approval = async () => { asked++; return false; };
  const viaSession = await runWorkspaceCommand(root, 'node', ['-e', "require('fs').writeFileSync('out.txt', '1'); console.log(1)"], { approval, autoApprove: true, ruleAllowed: true, sessionRuleOnly: true, timeoutSeconds: 10 });
  assert.equal(asked, 1, 'asked about inline code even with a session rule');
  assert.equal(viaSession.approved, false);
  const viaSettings = await runWorkspaceCommand(root, 'node', ['-e', "require('fs').writeFileSync('out.txt', '1'); console.log(1)"], { approval, autoApprove: true, ruleAllowed: true, timeoutSeconds: 10 });
  assert.equal(asked, 1, 'an explicit settings rule is trusted as written');
  assert.match(String(viaSettings.stdout || ''), /1/);
});
