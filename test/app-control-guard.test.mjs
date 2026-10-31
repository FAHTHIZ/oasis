import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executePowerTool, appControlRisk } from '../src/power-tools.mjs';

test('commands that attach to or close open apps are recognized', () => {
  for (const command of [
    '$p = New-Object -ComObject PowerPoint.Application; $p.Quit()',
    "[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')",
    'python -c "import win32com.client"',
    'osascript -e \'tell application "Keynote" to quit\'',
    'xdotool key ctrl+w',
    'Stop-Process -Name WINWORD',
    'taskkill /IM chrome.exe /F',
    'pkill -f code'
  ]) assert.ok(appControlRisk(command), command);
  for (const command of ['npm test', 'git status', 'echo Quitting soon', 'grep -r CreateObjectURL src']) assert.equal(appControlRisk(command), null, command);
});

test('a broad allow rule does not auto-run app control; the prompt warns and forces a real answer', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-appctl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompts = [];
  const approval = async (message, force) => { prompts.push({ message, force }); return false; };
  const denied = await executePowerTool('run_shell', { command: 'echo pkill -f nothing-matches-this' }, { root, ruleAllowed: true, autoApprove: true, approval, env: process.env }, root);
  assert.equal(denied.approved, false);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /^Warning: it can close or kill applications you have open\. Unsaved work/);
  assert.equal(prompts[0].force, true);
  const normal = await executePowerTool('run_shell', { command: 'echo hello' }, { root, ruleAllowed: true, autoApprove: true, approval, env: process.env }, root);
  assert.equal(normal.exitCode, 0);
  assert.equal(prompts.length, 1, 'ordinary allowed commands still run without a prompt');
  const bypass = await executePowerTool('run_shell', { command: 'echo pkill' }, { root, autoApprove: true, permissionMode: 'bypassPermissions', approval, env: process.env }, root);
  assert.equal(bypass.exitCode, 0, 'bypassPermissions is an explicit opt-out');
});
