import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import '../src/tools.mjs';
import { findPowerShell, powerShellLaunch, benignExitNote, shellCommandBlocked } from '../src/power-tools.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function fakePwsh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-pwsh-'));
  // Runs the -Command text (minus the encoding prefix) with /bin/sh and records its flags.
  await writeFile(path.join(dir, 'pwsh'), '#!/bin/sh\nfor a; do last="$a"; done\necho "flags: $1 $2" >&2\ncmd=$(printf %s "$last" | sed "s/^.*SilentlyContinue.; //")\nexec /bin/sh -c "$cmd"\n', { mode: 0o755 });
  return dir;
}

test('PowerShell is opt-in off Windows and on by default on Windows', async () => {
  const dir = await fakePwsh();
  assert.equal(findPowerShell({ PATH: dir }, 'linux'), null);
  assert.equal(findPowerShell({ PATH: dir, CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' }, 'linux'), path.join(dir, 'pwsh'));
  assert.equal(findPowerShell({ PATH: dir, CLAUDE_CODE_USE_POWERSHELL_TOOL: '0' }, 'win32'), null);
  const launch = powerShellLaunch('pwsh.exe', 'Get-Date', {}, 'win32');
  assert.deepEqual(launch.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.ok(!powerShellLaunch('pwsh.exe', 'x', { CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY: '1' }, 'win32').args.includes('Bypass'));
  assert.match(benignExitNote('rg foo', 1), /no matches/);
  assert.equal(benignExitNote('npm test', 1), null);
  assert.ok(shellCommandBlocked('Remove-Item -Recurse -Force C:\\'));
  assert.ok(shellCommandBlocked('Stop-Computer'));
  assert.equal(shellCommandBlocked('Remove-Item -Recurse ./build'), null);
});

test('the powershell tool runs through approval rules like Bash', async (t) => {
  const dir = await fakePwsh();
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-pwsh-root-'));
  const env = { ...process.env, HOME: root, PATH: dir + ':' + process.env.PATH, CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' };
  const settings = { permissions: { allow: ['PowerShell(echo:*)'], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const { config, requests } = await scriptedModel(t, [toolCall('p1', 'powershell', { command: 'echo hi-from-ps' }), toolCall('p2', 'powershell', { command: 'rm -rf build' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'powershell'));
  const prompts = [];
  await runAgentTurn(session, 'go', { env, approval: async (message) => { prompts.push(message); return false; } });
  const tools = requests[2].messages.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /hi-from-ps/);
  assert.match(tools[0].content, /-NoProfile -NonInteractive/);
  assert.match(tools[1].content, /not approved/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /PowerShell/);
});
