import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { addAnything } from '../src/add-anything.mjs';
import { pickReleaseAsset } from '../src/plugin-convert.mjs';
import { parseMcpServerEntries } from '../src/mcp-project.mjs';
import { connectMcpServers } from '../src/mcp.mjs';
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
  const trackerPlugin = plugins.find((p) => p.name === 'tracker');
  assert.deepEqual(servers.tracker, { command: 'tracker-mcp', cwd: trackerPlugin.root }, 'Agent Plugins stdio servers start in the plugin root');
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

// A bundled server as Codex plugins ship it (nexu-io/codex-slides): `node ./scripts/start.mjs`
// with "cwd": ".", which Codex resolves against the plugin root. OASIS used to start
// every MCP server in the workspace, so the script was not found.
const TINY_SERVER = [
  "let buffer = ''; process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result = {};",
  "    if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', serverInfo: { name: 'slides', version: '1' }, capabilities: { tools: {} } };",
  "    if (m.method === 'tools/list') result = { tools: [{ name: 'make_deck', inputSchema: { type: 'object', properties: {} } }] };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });"
].join('\n');

test('a Codex plugin MCP server with a relative cwd starts from the plugin root', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.codex-plugin/plugin.json': { name: 'slides', version: '0.1.0', skills: './skills/', mcpServers: './.mcp.json' },
    '.mcp.json': { mcpServers: { slides: { command: 'node', args: ['./scripts/start.mjs', '${PLUGIN_DATA}'], cwd: '.' } } },
    'scripts/start.mjs': TINY_SERVER,
    'skills/deck/SKILL.md': '---\nname: deck\ndescription: Make a deck\n---\nDeck.\n'
  });
  const added = await addAnything(src, { root, env, approve: async () => true });
  assert.match(added.message, /converted from a Codex plugin/);
  const plugins = await loadEnabledPlugins(root, { env });
  const [item] = await pluginMcpServers(plugins, { env, root });
  const spec = item.mcpServers.slides;
  assert.equal(spec.cwd, plugins[0].root);
  assert.equal(spec.args[0], './scripts/start.mjs');
  assert.equal(spec.args[1], item.env.CLAUDE_PLUGIN_DATA, '${PLUGIN_DATA} becomes the plugin data folder');
  const parsed = parseMcpServerEntries({ mcpServers: item.mcpServers }, { ...env, ...item.env }, 'plugin');
  assert.deepEqual(parsed.failures, []);
  assert.equal(parsed.servers[0].cwd, plugins[0].root);
  const { clients, failures } = await connectMcpServers({ env, root, skipUser: true, extraServers: parsed.servers });
  t.after(() => { for (const client of clients.values()) client.close(); });
  assert.deepEqual(failures.map((f) => f.error), []);
  const tools = [...clients.values()].flatMap((client) => client.tools.map((tool) => tool.name));
  assert.deepEqual(tools, ['make_deck']);
});

test('a local MCP server that dies on a missing dependency says how to fix it', async (t) => {
  const { exitHint } = await import('../src/mcp.mjs');
  assert.match(exitHint("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/p/node_modules/x/y.js'", '/p'), /npm install \(or pnpm install\) in \/p\./);
  assert.match(exitHint("ModuleNotFoundError: No module named 'mcp'", '/p'), /Python package/);
  assert.equal(exitHint('token=abc123 failed', '/p'), '', 'unknown stderr is not echoed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-dep-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'start.mjs'), "import 'not-installed-package-for-oasis-test';\n");
  const { failures } = await connectMcpServers({ env: { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') }, root: dir, skipUser: true, extraServers: [{ name: 'dep', command: process.execPath, args: ['start.mjs'], cwd: dir }] });
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /exited with code 1\. Its Node\.js dependencies are not installed/);
});

test('a plugin MCP server that needs an unset option says what to set instead of failing as "Invalid URL"', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.claude-plugin/plugin.json': { name: 'flows', version: '1.0.0', userConfig: { base_url: { type: 'string', title: 'Base URL', required: true } },
      mcpServers: { flows: { type: 'http', url: '${user_config.base_url}/mcp' }, local: { command: 'node', args: ['-v'] } } }
  });
  await addAnything(src, { root, env, approve: async () => true });
  let plugins = await loadEnabledPlugins(root, { env });
  let [item] = await pluginMcpServers(plugins, { env, root });
  assert.deepEqual(Object.keys(item.mcpServers), ['local'], 'the server that can start still starts');
  assert.equal(item.failures.length, 1);
  assert.equal(item.failures[0].name, 'flows');
  assert.match(item.failures[0].error, /^needs base_url: run oasis plugin config flows@[\w-]+ base_url=VALUE$/);
  const { setPluginOption } = await import('../src/claude-plugins.mjs');
  await setPluginOption(plugins[0], 'base_url', 'https://n8n.example.com', { env });
  plugins = await loadEnabledPlugins(root, { env });
  [item] = await pluginMcpServers(plugins, { env, root });
  assert.equal(item.mcpServers.flows.url, 'https://n8n.example.com/mcp');
  assert.deepEqual(item.failures, []);
});

test('an MCP server that cannot start says whether the program or its folder is missing', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-enoent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') };
  const { failures } = await connectMcpServers({ env, root: dir, skipUser: true, extraServers: [
    { name: 'noprog', command: 'oasis-test-no-such-program' },
    { name: 'nodir', command: process.execPath, args: ['-v'], cwd: path.join(dir, 'gone') }] });
  const byName = Object.fromEntries(failures.map((f) => [f.name, f.error]));
  assert.equal(byName.noprog, 'MCP server noprog could not start: the program "oasis-test-no-such-program" is not installed or not on your PATH.');
  assert.equal(byName.nodir, 'MCP server nodir could not start: its folder ' + path.join(dir, 'gone') + ' does not exist.');
});
