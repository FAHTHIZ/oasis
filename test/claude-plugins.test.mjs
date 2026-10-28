import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { addMarketplace, installPlugin, uninstallPlugin, setPluginEnabled, loadEnabledPlugins, pluginMcpServers, validatePath, readInstalledPlugins } from '../src/claude-plugins.mjs';
import { loadCustomCommands } from '../src/commands.mjs';
import { loadAgentDefinitions } from '../src/subagents.mjs';
import { listAvailableSkills, loadSkillText } from '../src/tools.mjs';
import { loadSettings } from '../src/settings.mjs';
import { runHooks } from '../src/hooks.mjs';

async function put(file, content) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-plugins-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_PLUGIN_DIRS: '', OASIS_PLUGINS: '' };
  const market = path.join(base, 'market');
  await put(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'demo-market', owner: { name: 'Test' }, plugins: [{ name: 'demo', source: './plugins/demo', description: 'Demo plugin' }] }));
  const plugin = path.join(market, 'plugins', 'demo');
  await put(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.2.3', description: 'Demo' }));
  await put(path.join(plugin, 'commands', 'hello.md'), '---\ndescription: Say hello\nargument-hint: [name]\n---\nGreet $ARGUMENTS using ${CLAUDE_PLUGIN_ROOT}/greeting.txt\n');
  await put(path.join(plugin, 'commands', 'git', 'pr.md'), 'Open a PR\n');
  await put(path.join(plugin, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\n---\nYou review code.\n');
  await put(path.join(plugin, 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Greeting workflow\n---\nRun ${CLAUDE_PLUGIN_ROOT}/scripts/greet.sh\n');
  await put(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "$CLAUDE_PLUGIN_ROOT" > "$CLAUDE_PROJECT_DIR/hook-ran.txt"' }] }] } }));
  await put(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { demo_db: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server', args: ['--data', '${CLAUDE_PLUGIN_DATA}'] } } }));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  return { base, home, env, market, root };
}

test('marketplace add + install activates plugin commands, agents, skills, hooks and MCP servers', async (t) => {
  const { env, market, root } = await fixture(t);
  const added = await addMarketplace(market, { env, cwd: root });
  assert.deepEqual(added.plugins, ['demo']);
  const installed = await installPlugin('demo@demo-market', { env, root });
  assert.equal(installed.id, 'demo@demo-market');
  assert.deepEqual(installed.summary.commands.sort(), ['/demo:git:pr', '/demo:hello']);
  assert.deepEqual(installed.summary.agents, ['demo:reviewer']);
  assert.deepEqual(installed.summary.skills, ['greet']);
  assert.equal(installed.summary.hooks, 1);
  assert.deepEqual(installed.summary.mcpServers, ['demo_db']);

  const commands = await loadCustomCommands(root, { env, home: env.HOME });
  const hello = commands.get('demo:hello');
  assert.ok(hello, 'plugin command is namespaced');
  assert.equal(hello.argumentHint, '[name]');
  assert.match(hello.body, new RegExp(installed.installPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/greeting.txt'));
  assert.ok(commands.get('demo:git:pr'));

  const agents = await loadAgentDefinitions(root, { env });
  assert.equal(agents['demo:reviewer'].description, 'Reviews code');

  const skills = await listAvailableSkills(root, { env });
  assert.equal(skills.find((s) => s.name === 'greet').source, 'plugin');
  const skill = await loadSkillText(root, 'greet', { env });
  assert.match(skill.content, /scripts\/greet\.sh/);
  assert.doesNotMatch(skill.content, /\$\{CLAUDE_PLUGIN_ROOT\}/);

  const settings = await loadSettings(root, { env });
  assert.equal(settings.hooks.PreToolUse.length, 1);
  await runHooks('PreToolUse', { tool_name: 'Bash', tool_name_oasis: 'run_command', tool_input: {} }, { hooks: settings.hooks, root, env });
  assert.equal((await readFile(path.join(root, 'hook-ran.txt'), 'utf8')).trim(), installed.installPath);

  const mcp = await pluginMcpServers(await loadEnabledPlugins(root, { env }), { env, root });
  assert.equal(mcp[0].mcpServers.demo_db.command, installed.installPath + '/bin/server');
  assert.doesNotMatch(mcp[0].mcpServers.demo_db.args[1], /\$\{/);

  await setPluginEnabled('demo', false, { env });
  assert.equal((await loadEnabledPlugins(root, { env })).length, 0);
  assert.equal((await loadCustomCommands(root, { env, home: env.HOME })).has('demo:hello'), false);
  await setPluginEnabled('demo', true, { env });
  await uninstallPlugin('demo', { env });
  assert.deepEqual(await readInstalledPlugins(env), {});
  await assert.rejects(access(installed.installPath));
});

test('git marketplaces are cloned, and plugins installed by Claude Code itself are picked up', async (t) => {
  const { env, market, root, home } = await fixture(t);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) {
    assert.equal(spawnSync('git', args, { cwd: market }).status, 0);
  }
  const added = await addMarketplace('file://' + market, { env, cwd: root });
  assert.equal(added.name, 'demo-market');
  assert.ok(added.location.startsWith(env.OASIS_CONFIG_DIR));

  // Simulate a plugin installed by Claude Code (v2 registry) and enabled in ~/.claude/settings.json.
  const claudePlugin = path.join(market, 'plugins', 'demo');
  await put(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'demo@claude-market': [{ scope: 'user', installPath: claudePlugin, version: '1.2.3' }] } }));
  await put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@claude-market': true } }));
  const plugins = await loadEnabledPlugins(root, { env });
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].origin, 'claude-code');
  assert.ok((await loadCustomCommands(root, { env, home })).has('demo:hello'));
});

test('project-enabled plugins need workspace trust; --plugin-dir loads a directory for the session', async (t) => {
  const { env, market, root } = await fixture(t);
  await addMarketplace(market, { env, cwd: root });
  await installPlugin('demo@demo-market', { env, root });
  await setPluginEnabled('demo', false, { env });
  await put(path.join(root, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@demo-market': true } }));
  assert.equal((await loadEnabledPlugins(root, { env })).length, 0, 'untrusted project settings cannot enable plugins');
  const sessionEnv = { ...env, OASIS_PLUGIN_DIRS: path.join(market, 'plugins', 'demo') };
  const plugins = await loadEnabledPlugins(root, { env: sessionEnv });
  assert.equal(plugins[0].origin, 'plugin-dir');
});

test('validate reports marketplace and plugin structure', async (t) => {
  const { market } = await fixture(t);
  const okMarket = await validatePath(market);
  assert.equal(okMarket.ok, true, okMarket.problems.join('; '));
  const okPlugin = await validatePath(path.join(market, 'plugins', 'demo'));
  assert.match(okPlugin.report[0], /2 command\(s\), 1 agent\(s\), 1 skill\(s\), 1 hook group\(s\), 1 MCP server\(s\)/);
  await put(path.join(market, 'plugins', 'demo', 'hooks', 'hooks.json'), JSON.stringify({ PreToolUse: [] }));
  const bad = await validatePath(path.join(market, 'plugins', 'demo'));
  assert.equal(bad.ok, false);
});
