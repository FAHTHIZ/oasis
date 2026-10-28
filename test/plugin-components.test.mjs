import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { loadEnabledPlugins, pluginLspServers, pluginOutputStyles, pluginBinDirs, pluginDefaultSettings, setPluginOption, validatePath, pluginMcpServers, pluginCli, missingPluginOptions, expandPluginVariables, pluginVariables } from '../src/claude-plugins.mjs';
import { loadSettings } from '../src/settings.mjs';
import { serverForFile } from '../src/lsp.mjs';
import { loadOutputStyles } from '../src/output-styles.mjs';
import { createSession, commandEnvironment } from '../src/agent.mjs';

async function put(file, content) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-plugin-components-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const plugin = path.join(base, 'golang-tools');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_PLUGIN_DIRS: plugin, OASIS_PLUGINS: '' };
  await put(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'golang-tools', version: '0.1.0',
    userConfig: {
      api_url: { type: 'string', title: 'API URL', description: 'Backend', default: 'https://api.example.test' },
      api_token: { type: 'string', title: 'Token', sensitive: true, required: true }
    },
    mcpServers: { backend: { command: 'backend-mcp', env: { URL: '${user_config.api_url}', TOKEN: '${user_config.api_token}' } } }
  }));
  await put(path.join(plugin, '.lsp.json'), JSON.stringify({ gopls: { command: '${CLAUDE_PLUGIN_ROOT}/bin/gopls', args: ['serve'], extensionToLanguage: { '.go': 'go', '.mod': 'go.mod' }, initializationOptions: { usePlaceholders: true } } }));
  await put(path.join(plugin, 'output-styles', 'terse.md'), '---\ndescription: Very short answers\n---\nAnswer in at most three sentences.\n');
  await put(path.join(plugin, 'bin', 'gotool'), '#!/bin/sh\necho gotool-ran "$@"\n');
  await chmod(path.join(plugin, 'bin', 'gotool'), 0o755);
  await put(path.join(plugin, 'agents', 'gopher.md'), '---\nname: gopher\ndescription: Go expert\ntools: Read, Grep\n---\nYou are a meticulous Go reviewer.\n');
  await put(path.join(plugin, 'settings.json'), JSON.stringify({ agent: 'gopher' }));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  return { base, home, env, plugin, root };
}

test('plugin LSP servers use Claude Code .lsp.json (extensionToLanguage) and reach the lsp tool', async (t) => {
  const { env, plugin, root } = await fixture(t);
  const plugins = await loadEnabledPlugins(root, { env });
  const servers = await pluginLspServers(plugins, { env, root });
  const gopls = servers['golang-tools:gopls'];
  assert.equal(gopls.command, path.join(plugin, 'bin', 'gopls'));
  assert.deepEqual(gopls.args, ['serve']);
  assert.deepEqual(gopls.extensions.sort(), ['.go', '.mod']);
  assert.equal(gopls.languageIds['.mod'], 'go.mod');
  assert.equal(gopls.env.CLAUDE_PLUGIN_ROOT, plugin);
  const settings = await loadSettings(root, { env });
  assert.ok(settings.lspServers['golang-tools:gopls']);
  const server = serverForFile('main.go', settings);
  assert.equal(server.name, 'golang-tools:gopls');
  assert.equal(server.plugin, 'golang-tools');
  assert.deepEqual(server.candidates[0].initializationOptions, { usePlaceholders: true });
});

test('plugin output styles load as plugin:style and apply to a session', async (t) => {
  const { env, root } = await fixture(t);
  const styles = await pluginOutputStyles(await loadEnabledPlugins(root, { env }));
  assert.equal(styles[0].name, 'golang-tools:terse');
  const all = await loadOutputStyles(root, { env });
  assert.ok(all['golang-tools:terse']);
  assert.match(all['golang-tools:terse'].prompt, /at most three sentences/);
  const session = await createSession({ root, config: { provider: 'openai', model: 'gpt-4.1', apiKey: 'x' }, env, outputStyle: 'golang-tools:terse' });
  assert.equal(session.outputStyle, 'golang-tools:terse');
  assert.match(session.messages[0].content, /at most three sentences/);
});

test('plugin bin/ is on PATH for commands the agent runs', async (t) => {
  const { env, plugin, root } = await fixture(t);
  assert.deepEqual(await pluginBinDirs(await loadEnabledPlugins(root, { env })), [path.join(plugin, 'bin')]);
  const settings = await loadSettings(root, { env });
  assert.deepEqual(settings.pluginBinDirs, [path.join(plugin, 'bin')]);
  if (process.platform === 'win32') return;
  const commandEnv = commandEnvironment(env, settings);
  const { executeTool } = await import('../src/tools.mjs');
  const result = await executeTool('run_command', { command: 'gotool', args: ['hi'] }, { root, env: commandEnv, autoApprove: true });
  assert.match(JSON.stringify(result), /gotool-ran hi/);
  assert.equal(commandEnvironment(env, { pluginBinDirs: [] }), env);
});

test('plugin settings.json agent becomes the main-thread agent; --agent overrides', async (t) => {
  const { env, root } = await fixture(t);
  assert.deepEqual(await pluginDefaultSettings(await loadEnabledPlugins(root, { env })), { agent: 'golang-tools:gopher', agentPlugin: 'golang-tools' });
  const config = { provider: 'openai', model: 'gpt-4.1', apiKey: 'x' };
  const session = await createSession({ root, config, env });
  assert.equal(session.mainAgent, 'golang-tools:gopher');
  assert.match(session.messages[0].content, /<main-agent name="golang-tools:gopher">[\s\S]*meticulous Go reviewer/);
  const names = session.toolDefinitions.map((tool) => tool.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('write_file'), 'agent tool list restricts the main session');
  const explicit = await createSession({ root, config, env, agent: 'missing-agent' });
  assert.match(explicit.agentWarning, /not found/);
  assert.equal(explicit.mainAgent, undefined);
  const bare = await createSession({ root, config, env, bare: true });
  assert.equal(bare.mainAgent, undefined);
});

test('userConfig: defaults, sensitive storage, ${user_config.KEY} and CLAUDE_PLUGIN_OPTION_ env', async (t) => {
  const { env, root } = await fixture(t);
  let [plugin] = await loadEnabledPlugins(root, { env });
  assert.deepEqual(plugin.options, { api_url: 'https://api.example.test' });
  assert.deepEqual(missingPluginOptions(plugin), ['api_token']);
  await setPluginOption(plugin, 'api_token', 's3cret', { env });
  await setPluginOption(plugin, 'api_url', 'https://other.test', { env });
  await assert.rejects(setPluginOption(plugin, 'nope', '1', { env }), /no option "nope"/);
  const secrets = path.join(env.OASIS_CONFIG_DIR, 'plugins', 'plugin-secrets.json');
  assert.equal(JSON.parse(await readFile(secrets, 'utf8'))['golang-tools'].api_token, 's3cret');
  if (process.platform !== 'win32') assert.equal((await stat(secrets)).mode & 0o777, 0o600);
  const userSettings = JSON.parse(await readFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.equal(userSettings.pluginConfigs['golang-tools'].options.api_url, 'https://other.test');
  assert.ok(!JSON.stringify(userSettings).includes('s3cret'), 'sensitive values never land in settings.json');
  [plugin] = await loadEnabledPlugins(root, { env });
  assert.deepEqual(missingPluginOptions(plugin), []);
  const vars = pluginVariables(plugin, env, root);
  assert.equal(vars.CLAUDE_PLUGIN_OPTION_API_URL, 'https://other.test');
  assert.equal(expandPluginVariables('${user_config.api_url}/v1', vars), 'https://other.test/v1');
  const [mcp] = await pluginMcpServers([plugin], { env, root });
  assert.deepEqual(mcp.mcpServers.backend.env, { URL: 'https://other.test', TOKEN: 's3cret' });
});

test('plugin CLI show/config and validate report the new components', async (t) => {
  const { env, plugin, root } = await fixture(t);
  let output = '';
  const write = (text) => { output += text; };
  await pluginCli(root, ['show', 'golang-tools'], { env, write });
  assert.match(output, /LSP servers: golang-tools:gopls/);
  assert.match(output, /output styles: golang-tools:terse/);
  assert.match(output, /bin\/ on PATH: yes/);
  assert.match(output, /default agent: golang-tools:gopher/);
  assert.match(output, /missing required: api_token/);
  output = '';
  await pluginCli(root, ['config', 'golang-tools', 'api_token=abc'], { env, write });
  assert.match(output, /stored in a private file/);
  output = '';
  await pluginCli(root, ['config', 'golang-tools'], { env, write });
  assert.match(output, /api_token\s+\(set, hidden\)/);
  const valid = await validatePath(plugin);
  assert.ok(valid.ok, valid.problems.join('; '));
  assert.match(valid.report.join('\n'), /1 LSP server\(s\), 1 output style\(s\), bin\/ executables, default agent golang-tools:gopher/);
  await put(path.join(plugin, '.lsp.json'), JSON.stringify({ broken: { command: 'x' } }));
  const invalid = await validatePath(plugin);
  assert.ok(!invalid.ok);
  assert.match(invalid.problems.join('\n'), /extensionToLanguage/);
});

test('plugins disabled with OASIS_PLUGINS=off contribute nothing', async (t) => {
  const { env, root } = await fixture(t);
  const off = { ...env, OASIS_PLUGINS: 'off' };
  const settings = await loadSettings(root, { env: off });
  assert.deepEqual(settings.pluginBinDirs, []);
  assert.equal(settings.agent, null);
  assert.ok(!Object.keys(settings.lspServers).some((name) => name.includes(':')));
});
