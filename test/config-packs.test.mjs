import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { addAnything } from '../src/add-anything.mjs';
import { loadEnabledPlugins, pluginSkills, pluginMcpServers, pluginCommands } from '../src/claude-plugins.mjs';

async function fixture(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-packs-'));
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

const servers = async (plugins, env, root) => Object.assign({}, ...(await pluginMcpServers(plugins, { env, root })).map((m) => m.mcpServers));
const install = async (src, root, env) => {
  const asked = [];
  await addAnything(src, { root, env, approve: async (s) => { asked.push(s); return true; } });
  return { asked, plugins: await loadEnabledPlugins(root, { env }) };
};

const bundle = {
  manifest_version: '0.3', name: 'weather-bundle', version: '1.2.0', description: 'Weather tools',
  server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '--key=${user_config.api_key}'] } },
  user_config: { api_key: { type: 'string', title: 'API key', description: 'Your key', sensitive: true, required: true } },
  prompts: [{ name: 'forecast', description: 'Get a forecast', arguments: ['city'], text: 'Forecast for ${arguments.city}.' }]
};

test('an MCP Bundle folder installs: server rooted in the plugin, user_config asked, prompts become commands', async (t) => {
  const { src, root, env } = await fixture(t, { 'manifest.json': bundle, 'server/index.js': '// server\n' });
  const { asked, plugins } = await install(src, root, env);
  assert.match(asked[0], /weather-bundle/);
  assert.deepEqual(plugins.map((p) => p.name), ['weather-bundle']);
  const [entry] = await pluginMcpServers(plugins, { env, root });
  assert.match(entry.failures[0].error, /needs api_key/, 'a required option nobody set is reported, not started');
  plugins[0].options = { api_key: 'k' };
  const s = Object.values(await servers(plugins, env, root))[0];
  assert.equal(s.command, 'node');
  assert.equal(s.args[1], '--key=k');
  assert.equal(s.args[0], plugins[0].root + '/server/index.js');
  const commands = await pluginCommands(plugins, { env });
  const forecast = commands.find((c) => /forecast/.test(c.name));
  assert.ok(forecast, commands.map((c) => c.name).join());
  assert.doesNotMatch(forecast.body, /\$\{arguments/);
});

test('a packed .mcpb file installs from a local path', async (t) => {
  const { base, root, env } = await fixture(t, {});
  const file = path.join(base, 'weather.mcpb');
  await writeFile(file, zipSync({ 'manifest.json': strToU8(JSON.stringify(bundle)), 'server/index.js': strToU8('// s\n') }));
  const { plugins } = await install(file, root, env);
  assert.deepEqual(plugins.map((p) => p.name), ['weather-bundle']);
});

test('a VS Code / Copilot customization repo becomes one plugin', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.github/prompts/explain.prompt.md': '---\ndescription: Explain code\n---\nExplain ${input:topic}.\n',
    '.github/agents/planner.agent.md': '---\ndescription: Plans work\ntools: [search]\n---\nYou plan.\n',
    '.github/instructions/ts.instructions.md': '---\napplyTo: "**/*.ts"\n---\nPrefer const.\n',
    '.vscode/mcp.json': { inputs: [{ id: 'token', type: 'promptString', description: 'Token', password: true }], servers: { gh: { command: 'gh-mcp', args: ['${workspaceFolder}'], env: { TOKEN: '${input:token}' } } } }
  });
  const { asked, plugins } = await install(src, root, env);
  assert.equal(plugins.length, 1, asked.join('\n'));
  const commands = await pluginCommands(plugins, { env });
  assert.ok(commands.some((c) => /explain/.test(c.name)), commands.map((c) => c.name).join());
  const skills = await pluginSkills(plugins, { env });
  assert.ok(skills.length >= 1);
  const gh = (await servers(plugins, env, root)).gh;
  assert.ok(gh, 'mcp.json server carried');
  assert.equal(gh.command, 'gh-mcp');
});

test('a Cursor rules-only repo becomes a plugin whose rules are skills', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.cursor/rules/style.mdc': '---\ndescription: House style\nglobs: "**/*.ts"\nalwaysApply: false\n---\nUse named exports.\n'
  });
  const { plugins } = await install(src, root, env);
  assert.equal(plugins.length, 1);
  const skills = await pluginSkills(plugins, { env });
  assert.ok(skills.some((s) => /style/.test(s.name)), JSON.stringify(skills.map((s) => s.name)));
});

test('a Continue block installs its rules and MCP servers', async (t) => {
  const { src, root, env } = await fixture(t, {
    'config.yaml': 'name: my-block\nversion: 0.0.1\nschema: v1\nrules:\n  - name: tests\n    rule: Always write tests.\nmcpServers:\n  - name: db\n    command: db-mcp\n    env:\n      KEY: ${{ secrets.DB_KEY }}\n'
  });
  const { plugins } = await install(src, root, env);
  assert.equal(plugins.length, 1);
  const db = (await servers(plugins, { ...env, DB_KEY: 'k' }, root)).db;
  assert.ok(db);
  assert.equal(db.command, 'db-mcp');
  const skills = await pluginSkills(plugins, { env });
  assert.ok(skills.some((s) => /tests/.test(s.name)), JSON.stringify(skills.map((s) => s.name)));
});

test('an .mcpb download link installs as a bundle, not as a remote MCP server', async (t) => {
  const { classifySource } = await import('../src/add-anything.mjs');
  assert.equal(classifySource('https://example.com/dl/weather.mcpb').archive, 'https://example.com/dl/weather.mcpb');
  const http = await import('node:http');
  const body = Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(bundle)), 'server/index.js': strToU8('// s\n') }));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(body); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { root, env } = await fixture(t, {});
  const { plugins } = await install('http://127.0.0.1:' + server.address().port + '/weather.mcpb', root, env);
  assert.deepEqual(plugins.map((p) => p.name), ['weather-bundle']);
});
