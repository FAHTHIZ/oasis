import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { loadSettings } from '../src/settings.mjs';
import { runHooks } from '../src/hooks.mjs';
import { loadForeignHooks } from '../src/foreign-hooks.mjs';

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-foreign-hooks-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'), home = path.join(base, 'home');
  await mkdir(path.join(root, '.cursor', 'hooks'), { recursive: true });
  await mkdir(path.join(root, '.github', 'hooks'), { recursive: true });
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  // A script that records which tool's protocol it was called with, then denies.
  const script = [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const input = JSON.parse(readFileSync(0, 'utf8'));",
    "writeFileSync(process.argv[2], JSON.stringify(input));",
    "process.stdout.write(JSON.stringify({ permission: 'deny', agent_message: 'Cursor says no.' }));"
  ].join('\n');
  await writeFile(path.join(root, '.cursor', 'hooks', 'guard.mjs'), script);
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_TRUST_WORKSPACE: '1' };
  return { root, home, env, log: path.join(base, 'seen.json') };
}

test('project .cursor/hooks.json runs live through the bridge, with relative scripts rooted at the project', async (t) => {
  const { root, env, log } = await setup(t);
  // Cursor runs project hooks from the project root, so the path is relative to it.
  const node = JSON.stringify(process.execPath);
  await writeFile(path.join(root, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: `${node} .cursor/hooks/guard.mjs ${JSON.stringify(log)}` }] } }));
  const settings = await loadSettings(root, { env });
  const groups = settings.hooks.PreToolUse || [];
  const hook = groups.flatMap((group) => group.hooks).find((item) => item.protocol === 'cursor');
  assert.ok(hook, 'the Cursor hook is loaded');
  assert.equal(hook.foreignEvent, 'beforeShellExecution');
  const result = await runHooks('PreToolUse', { session_id: 's1', tool_name: 'Bash', oasis_tool_name: 'run_shell', tool_name_oasis: 'run_shell', tool_input: { command: 'rm -rf dist' } }, { hooks: settings.hooks, root });
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.reason, /Cursor says no/);
  const input = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(input.hook_event_name, 'beforeShellExecution');
  assert.equal(input.command, 'rm -rf dist');
});

test('a relative script path that exists is made absolute; other commands are left as written', async (t) => {
  const { root, home, env } = await setup(t);
  await writeFile(path.join(root, '.cursor', 'hooks.json'), JSON.stringify({ hooks: { stop: [{ command: '.cursor/hooks/guard.mjs --x' }, { command: 'npx prettier --check .' }] } }));
  const [item] = await loadForeignHooks(root, { env, home, trusted: true });
  const commands = Object.values(item.hooks).flat().flatMap((group) => group.hooks).map((hook) => hook.command);
  assert.ok(commands.includes(JSON.stringify(path.join(root, '.cursor', 'hooks', 'guard.mjs')) + ' --x'));
  assert.ok(commands.includes('npx prettier --check .'));
});

test('Copilot .github/hooks/*.json load too; project files need trust, the user Cursor file does not', async (t) => {
  const { root, home, env } = await setup(t);
  await writeFile(path.join(root, '.github', 'hooks', 'policy.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: 'echo copilot', timeoutSec: 5 }] } }));
  await writeFile(path.join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'echo user-cursor' }] } }));
  const trusted = await loadForeignHooks(root, { env, home, trusted: true });
  assert.deepEqual(trusted.map((item) => [item.scope, item.protocol]).sort(), [['project', 'copilot'], ['user', 'cursor']]);
  const untrusted = await loadForeignHooks(root, { env, home, trusted: false });
  assert.deepEqual(untrusted.map((item) => item.scope), ['user']);
  // Untrusted workspace through loadSettings: no Copilot hook from the repo.
  const settings = await loadSettings(root, { env: { ...env, OASIS_TRUST_WORKSPACE: '0' } });
  const all = Object.values(settings.hooks).flat().flatMap((group) => group.hooks);
  assert.ok(!all.some((hook) => hook.protocol === 'copilot'));
  assert.ok(all.some((hook) => hook.protocol === 'cursor' && hook.command === 'echo user-cursor'));
});

test('OASIS_OTHER_AGENT_RULES=0 and "otherAgentHooks": false turn it off', async (t) => {
  const { root, home, env } = await setup(t);
  await writeFile(path.join(root, '.github', 'hooks', 'policy.json'), JSON.stringify({ hooks: { preToolUse: [{ bash: 'echo copilot' }] } }));
  assert.deepEqual(await loadForeignHooks(root, { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' }, home, trusted: true }), []);
  await mkdir(env.OASIS_CONFIG_DIR, { recursive: true });
  await writeFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), JSON.stringify({ otherAgentHooks: false }));
  const settings = await loadSettings(root, { env });
  assert.ok(!Object.values(settings.hooks).flat().flatMap((group) => group.hooks).some((hook) => hook.protocol));
});
