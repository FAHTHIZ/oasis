import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { exportPlugin, formatExportReport, inspectPlugin, formatInspectReport, commandToGeminiToml, geminiMatcher } from '../src/plugin-export.mjs';
import { detectForeignPlugin } from '../src/plugin-convert.mjs';
import { validatePath } from '../src/claude-plugins.mjs';
import { parse as parseToml } from 'smol-toml';

async function fixture(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-export-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const src = path.join(base, 'src');
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(src, rel)), { recursive: true });
    await writeFile(path.join(src, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { base, src, out: path.join(base, 'out') };
}

const plugin = {
  '.claude-plugin/plugin.json': { name: 'kit', version: '1.0.0', description: 'A kit', author: { name: 'A' },
    userConfig: { api_key: { type: 'string', title: 'API key', description: 'Key', sensitive: true } } },
  '.mcp.json': { mcpServers: { kit: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { KEY: '${user_config.api_key}' } } } },
  'commands/review.md': '---\ndescription: Review a change\n---\nReview $ARGUMENTS carefully.\n',
  'agents/planner.md': '---\nname: planner\ndescription: Plans work\n---\nYou plan.\n',
  'skills/style/SKILL.md': '---\nname: style\ndescription: House style\n---\nUse tabs.\n',
  'hooks/hooks.json': { hooks: { PreToolUse: [{ matcher: 'Bash|Edit', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/guard.sh', timeout: 5 }] }], SubagentStop: [{ hooks: [{ type: 'command', command: 'x' }] }] } },
  'server.js': '// s\n', 'guard.sh': '#!/bin/sh\n'
};

test('export writes one folder every agent can install', async (t) => {
  const { src, out } = await fixture(t, plugin);
  const result = await exportPlugin(src, { out });
  assert.deepEqual(result.report.map((r) => r.target), ['claude', 'codex', 'gemini', 'cursor', 'copilot']);
  const read = async (rel) => JSON.parse(await readFile(path.join(out, rel), 'utf8'));

  const claude = await read('.claude-plugin/plugin.json');
  assert.equal(claude.hooks, './hooks/claude-hooks.json');
  assert.equal((await validatePath(out)).ok, true);

  const codex = await read('.codex-plugin/plugin.json');
  assert.equal(codex.skills, './codex/skills/');
  assert.deepEqual((await readdir(path.join(out, 'codex', 'skills'))).sort(), ['agent-planner', 'review', 'style']);
  assert.match(await readFile(path.join(out, 'codex/skills/review/SKILL.md'), 'utf8'), /Review the user's request carefully/);

  const gemini = await read('gemini-extension.json');
  assert.deepEqual(gemini.mcpServers.kit.args, ['${extensionPath}/server.js']);
  assert.equal(gemini.mcpServers.kit.env.KEY, '$API_KEY');
  assert.deepEqual(gemini.settings, [{ name: 'API key', description: 'Key', envVar: 'API_KEY', sensitive: true }]);
  const toml = parseToml(await readFile(path.join(out, 'commands/review.toml'), 'utf8'));
  assert.equal(toml.description, 'Review a change');
  assert.match(toml.prompt, /Review \{\{args\}\} carefully/);
  const gh = await read('hooks/hooks.json');
  assert.equal(gh.hooks.BeforeTool[0].matcher, 'run_shell_command|replace');
  assert.equal(gh.hooks.BeforeTool[0].hooks[0].command, '${extensionPath}/guard.sh');
  assert.equal(gh.hooks.BeforeTool[0].hooks[0].timeout, 5000);
  assert.ok(result.report.find((r) => r.target === 'gemini').dropped.some((d) => /SubagentStop/.test(d)));

  const cursor = await read('.cursor-plugin/plugin.json');
  assert.ok(cursor.variables.properties.api_key);
  assert.equal((await read('mcp.json')).mcpServers.kit.env.KEY, '${api_key}');

  const copilot = await read('.plugin/plugin.json');
  assert.equal(copilot.agents, './copilot/agents/');
  assert.match(await readFile(path.join(out, 'copilot/agents/planner.agent.md'), 'utf8'), /You plan/);

  // OASIS still reads the result as its own plugin first.
  assert.equal(await detectForeignPlugin(out).then((info) => info && info.format), 'gemini', 'foreign detection sees the overlay');
  assert.match(formatExportReport(result), /Gemini CLI\s+gemini-extension\.json/);
});

test('a single target and a foreign source', async (t) => {
  const { src, out } = await fixture(t, {
    'gemini-extension.json': { name: 'gem', version: '0.1.0', mcpServers: { g: { command: 'node', args: ['${extensionPath}/a.js'] } } },
    'commands/hi.toml': 'description = "Say hi"\nprompt = "Hi {{args}}"\n'
  });
  const result = await exportPlugin(src, { out, targets: ['cursor'] });
  assert.equal(result.from, 'Gemini CLI extension');
  const servers = JSON.parse(await readFile(path.join(out, 'mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(servers.g.args, ['${CLAUDE_PLUGIN_ROOT}/a.js']);
  await assert.rejects(exportPlugin(src, { out, targets: ['cursor'] }), /not empty/);
  await assert.rejects(exportPlugin(src, { out, targets: ['emacs'], force: true }), /Unknown export target/);
});

test('helpers', () => {
  assert.equal(geminiMatcher('Bash|Read|mcp__gh__issue'), 'run_shell_command|read_file|gh__issue');
  assert.match(commandToGeminiToml('Do """this""" $1'), /prompt = """\nDo \\"\\"\\"this\\"\\"\\" \{\{args\}\}\n"""/);
});

test('oasis add installs an exported folder as the native plugin', async (t) => {
  const { base, src, out } = await fixture(t, plugin);
  await exportPlugin(src, { out });
  const { addAnything } = await import('../src/add-anything.mjs');
  const { loadEnabledPlugins, pluginCommands, pluginHooks } = await import('../src/claude-plugins.mjs');
  const root = path.join(base, 'proj');
  await mkdir(root);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg'), HOME: path.join(base, 'home') };
  const asked = [];
  await addAnything(out, { root, env, approve: async (s) => { asked.push(s); return true; } });
  assert.doesNotMatch(asked[0], /Gemini/);
  const plugins = await loadEnabledPlugins(root, { env });
  assert.deepEqual(plugins.map((p) => p.name), ['kit']);
  assert.deepEqual((await pluginCommands(plugins, { env })).map((c) => c.name).sort(), ['kit:review']);
  assert.ok((await pluginHooks(plugins, { env })).some((h) => h.hooks.PreToolUse));
});

test('a marketplace exports every local plugin and a marketplace file per agent', async (t) => {
  const { src, out } = await fixture(t, {
    '.claude-plugin/marketplace.json': { name: 'tools', owner: { name: 'Me' }, plugins: [
      { name: 'kit', source: './plugins/kit', description: 'A kit' },
      { name: 'remote', source: { source: 'github', repo: 'o/r' } }] },
    ...Object.fromEntries(Object.entries(plugin).map(([rel, body]) => ['plugins/kit/' + rel, body]))
  });
  const { exportMarketplace, formatMarketplaceReport } = await import('../src/plugin-export.mjs');
  const result = await exportMarketplace(src, { out });
  assert.deepEqual(result.plugins.map((p) => p.name), ['kit']);
  assert.deepEqual(result.skipped, ['remote']);
  const read = async (rel) => JSON.parse(await readFile(path.join(out, rel), 'utf8'));
  assert.equal((await read('.claude-plugin/marketplace.json')).plugins[0].source, './plugins/kit');
  assert.deepEqual((await read('.agents/plugins/marketplace.json')).plugins[0].source, { source: 'local', path: './plugins/kit' });
  assert.equal((await read('.cursor-plugin/marketplace.json')).plugins[0].name, 'kit');
  assert.equal((await read('.github/plugin/marketplace.json')).plugins[0].name, 'kit');
  assert.ok(await read('plugins/kit/gemini-extension.json'));
  const { detectForeignMarketplace } = await import('../src/plugin-convert.mjs');
  assert.equal((await detectForeignMarketplace(out)).plugins[0].path, path.join(out, 'plugins', 'kit'));
  assert.match(formatMarketplaceReport(result), /not exported \(not in this repository\): remote/);
});

test('inspect reports what a plugin becomes in OASIS and every other agent without writing anything', async (t) => {
  const { base, src } = await fixture(t, plugin);
  const before = await readdir(base);
  const result = await inspectPlugin(src);
  assert.equal(result.native, true);
  assert.equal(result.format, 'Claude Code plugin');
  assert.deepEqual(result.targets.map((x) => x.target), ['claude', 'codex', 'gemini', 'cursor', 'copilot']);
  assert.equal(result.targets.find((x) => x.target === 'claude').full, true);
  assert.equal(result.targets.find((x) => x.target === 'cursor').full, false);
  assert.deepEqual(await readdir(base), before);
  const text = formatInspectReport(result);
  assert.match(text, /OASIS reads it natively/);
  assert.match(text, /\[full\]\s+OASIS \/ Claude Code/);
  assert.match(text, /\[partial\] Cursor/);

  const gem = await fixture(t, {
    'gemini-extension.json': { name: 'gx', version: '1.0.0', mcpServers: { s: { command: 'node', args: ['${extensionPath}/s.js'] } } },
    'commands/hi.toml': 'description = "Say hi"\nprompt = "Say hi to {{args}}"\n',
    's.js': '//\n'
  });
  const foreign = await inspectPlugin(gem.src);
  assert.equal(foreign.native, false);
  assert.equal(foreign.format, 'Gemini CLI extension');
  assert.ok(foreign.contents.some((c) => /^1 command\b/.test(c)));
  assert.match(formatInspectReport(foreign), /OASIS converts it on install/);
  await assert.rejects(inspectPlugin(path.join(base, 'nope')), /No plugin folder/);
});
