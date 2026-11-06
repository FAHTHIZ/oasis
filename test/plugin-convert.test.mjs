import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { addAnything } from '../src/add-anything.mjs';
import { pickReleaseAsset } from '../src/plugin-convert.mjs';
import { loadEnabledPlugins, pluginCommands, pluginSkills, pluginMcpServers, pluginHooks } from '../src/claude-plugins.mjs';

async function fixture(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-convert-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const src = path.join(base, 'src');
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(src, rel)), { recursive: true });
    await writeFile(path.join(src, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const root = path.join(base, 'proj');
  await mkdir(root);
  return { base, src, root, env: { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg'), HOME: path.join(base, 'home') } };
}

test('a Gemini CLI extension installs as a working plugin: commands, context, settings, hooks and MCP servers', async (t) => {
  const { src, root, env } = await fixture(t, {
    'gemini-extension.json': { name: 'demo-ext', version: '1.2.0', description: 'Demo tools', contextFileName: 'GEMINI.md',
      mcpServers: { tool: { command: 'node', args: ['${extensionPath}${/}server.js'], cwd: '${extensionPath}' }, remote: { httpUrl: 'https://example.com/mcp' } },
      settings: [{ name: 'API key', description: 'Your key', envVar: 'DEMO_API_KEY', sensitive: true }, { name: 'Region', envVar: 'DEMO_REGION' }] },
    'GEMINI.md': 'Always call the tool before answering.\n',
    'commands/review.toml': 'description = "Review code"\nprompt = """Review {{args}} carefully. !{git diff}"""\n',
    'commands/git/commit.toml': 'prompt = "Write a commit message"\n',
    'hooks/hooks.json': { hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: '${extensionPath}/check.sh' }] }], Unknown: [] } },
    'skills/lint/SKILL.md': '---\nname: lint\ndescription: Lint files\n---\nLint.\n',
    'server.js': ''
  });
  const asked = [];
  const result = await addAnything(src, { root, env, approve: async (s) => { asked.push(s); return true; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Gemini CLI extension "demo-ext"/);
  assert.match(asked[0], /2 commands/);
  assert.match(asked[0], /DEMO_API_KEY/);
  assert.equal(result.kind, 'foreign-plugin');
  const plugins = await loadEnabledPlugins(root, { env });
  assert.deepEqual(plugins.map((p) => p.name), ['demo-ext']);
  const commands = await pluginCommands(plugins, { env });
  assert.deepEqual(commands.map((c) => c.name).sort(), ['demo-ext:git-commit', 'demo-ext:review']);
  const review = commands.find((c) => c.name === 'demo-ext:review');
  assert.match(review.body, /Review \$ARGUMENTS carefully\. !`git diff`/);
  const skills = (await pluginSkills(plugins)).map((s) => s.name).sort();
  assert.deepEqual(skills, ['demo-ext-guide', 'lint']);
  const servers = Object.assign({}, ...(await pluginMcpServers(plugins, { env, root })).map((m) => m.mcpServers));
  assert.equal(servers.tool.args[0], plugins[0].root + '/server.js');
  assert.equal(servers.tool.cwd, plugins[0].root);
  assert.deepEqual(servers.remote, { type: 'http', url: 'https://example.com/mcp' });
  assert.ok('DEMO_API_KEY' in servers.tool.env);
  const hooks = (await pluginHooks(plugins, { env, root })).map((h) => h.hooks);
  assert.deepEqual(Object.keys(Object.assign({}, ...hooks)), ['PreToolUse']);
  assert.deepEqual(result.needs, { 'demo-ext@repo-demo-ext': ['DEMO_API_KEY', 'DEMO_REGION'] });
  const saved = await addAnything('demo-ext', { root, env, values: { DEMO_REGION: 'eu' }, approve: async () => true });
  assert.equal(saved.kind, 'configure');
  assert.match(saved.message, /Still missing: demo-ext@repo-demo-ext needs DEMO_API_KEY/);
  const [reloaded] = await loadEnabledPlugins(root, { env });
  const tool = Object.assign({}, ...(await pluginMcpServers([reloaded], { env, root })).map((m) => m.mcpServers)).tool;
  assert.equal(tool.env.DEMO_REGION, 'eu');
});

test('a Codex marketplace lists its plugins and installs the one picked with #name', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.agents/plugins/marketplace.json': { name: 'team', plugins: [
      { name: 'helper', source: { source: 'local', path: './plugins/helper' }, policy: { installation: 'AVAILABLE' } },
      { name: 'tracker', source: './plugins/tracker' },
      { name: 'outside', source: { source: 'local', path: '../escape' } }] },
    'plugins/helper/.codex-plugin/plugin.json': { name: 'helper', version: '0.1.0', description: 'Helps', skills: './skills/' },
    'plugins/helper/skills/plan/SKILL.md': '---\nname: plan\ndescription: Plan work\n---\nPlan.\n',
    'plugins/tracker/plugin.json': { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'tracker', description: 'Issues' },
    'plugins/tracker/mcp.json': { mcpServers: { tracker: { type: 'stdio', command: 'tracker-mcp' } } }
  });
  const listed = await addAnything(src, { root, env, approve: async () => true });
  assert.deepEqual(listed.available, ['helper', 'tracker']);
  const helper = await addAnything(src + '#helper', { root, env, approve: async () => true });
  assert.match(helper.message, /converted from a Codex plugin/);
  const tracker = await addAnything(src + '#tracker', { root, env, approve: async () => true });
  assert.match(tracker.message, /Agent Plugins/);
  const plugins = await loadEnabledPlugins(root, { env });
  assert.deepEqual(plugins.map((p) => p.name).sort(), ['helper', 'tracker']);
  assert.deepEqual((await pluginSkills(plugins)).map((s) => s.name), ['plan']);
  const servers = Object.assign({}, ...(await pluginMcpServers(plugins, { env, root })).map((m) => m.mcpServers));
  assert.deepEqual(servers.tracker, { command: 'tracker-mcp' });
  await assert.rejects(addAnything(src + '#nope', { root, env, approve: async () => true }), /no plugin called nope/);
});

test('Gemini release archives are chosen the way Gemini CLI chooses them', () => {
  const assets = ['darwin.arm64.x.tar.gz', 'linux.x64.x.tar.gz', 'win32.x.zip', 'notes.txt'].map((name) => ({ name }));
  assert.equal(pickReleaseAsset(assets, { platform: 'linux', arch: 'x64' }).name, 'linux.x64.x.tar.gz');
  assert.equal(pickReleaseAsset(assets, { platform: 'win32', arch: 'x64' }).name, 'win32.x.zip');
  assert.equal(pickReleaseAsset(assets, { platform: 'linux', arch: 'arm64' }), null);
  assert.equal(pickReleaseAsset([{ name: 'ext.tar.gz' }], { platform: 'linux', arch: 'arm64' }).name, 'ext.tar.gz');
  assert.equal(pickReleaseAsset([], {}), null);
});
