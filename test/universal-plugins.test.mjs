import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { addAnything } from '../src/add-anything.mjs';
import { loadEnabledPlugins, pluginSkills, pluginMcpServers, pluginHooks, pluginCommands, pluginVariables, expandPluginVariables, validatePath } from '../src/claude-plugins.mjs';

async function fixture(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-universal-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const src = path.join(base, 'src');
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(src, rel)), { recursive: true });
    await writeFile(path.join(src, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const root = path.join(base, 'proj');
  await mkdir(root);
  return { src, root, env: { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg'), HOME: path.join(base, 'home') } };
}

const servers = async (plugins, env, root) => Object.assign({}, ...(await pluginMcpServers(plugins, { env, root })).map((m) => m.mcpServers));

test('an OASIS plugin (.oasis-plugin/plugin.json) installs natively and expands every variable spelling', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.oasis-plugin/plugin.json': { name: 'native-one', version: '0.1.0', description: 'Ours',
      mcpServers: { a: { command: '${OASIS_PLUGIN_ROOT}/srv', args: ['${PLUGIN_DATA}', '${CLAUDE_PLUGIN_ROOT}'] } } },
    'commands/hello.md': '---\ndescription: Hi\n---\nSay hi from ${OASIS_PLUGIN_ROOT}.\n'
  });
  const asked = [];
  await addAnything(src, { root, env, approve: async (s) => { asked.push(s); return true; } });
  assert.match(asked[0], /OASIS plugin "native-one"/);
  const plugins = await loadEnabledPlugins(root, { env });
  assert.deepEqual(plugins.map((p) => p.name), ['native-one']);
  const a = (await servers(plugins, env, root)).a;
  assert.equal(a.command, plugins[0].root + '/srv');
  assert.equal(a.args[1], plugins[0].root);
  assert.notEqual(a.args[0], '${PLUGIN_DATA}');
  const [command] = await pluginCommands(plugins, { env });
  assert.match(command.body, new RegExp('Say hi from ' + plugins[0].root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const vars = pluginVariables(plugins[0], env, root);
  for (const key of ['OASIS_PLUGIN_ROOT', 'OASIS_PLUGIN_DATA', 'PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'COPILOT_PLUGIN_DATA', 'OASIS_PROJECT_DIR']) assert.ok(vars[key], key);
  assert.equal(expandPluginVariables('${OASIS_PLUGIN_DATA}', { CLAUDE_PLUGIN_DATA: '/d' }), '/d', 'neutral names fall back to the Claude ones');
  const report = await validatePath(src);
  assert.equal(report.ok, true, report.problems.join('; '));
  assert.match(report.report[0], /Plugin "native-one"/);
});

test('a Cursor plugin installs: rules become skills, mcp.json servers start, Cursor hooks run through the bridge', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.cursor-plugin/plugin.json': { name: 'cursor-kit', version: '1.0.0', description: 'Kit' },
    'rules/style.mdc': '---\ndescription: House style for TypeScript\nglobs: "**/*.ts"\nalwaysApply: false\n---\nUse named exports.\n',
    'skills/review/SKILL.md': '---\nname: review\ndescription: Review\n---\nReview.\n',
    'mcp.json': { mcpServers: { kit: { command: './bin/kit' } } },
    'hooks/hooks.json': { version: 1, hooks: { beforeShellExecution: [{ command: './hooks/guard.sh' }], beforeTabFileRead: [{ command: './tab.sh' }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${PLUGIN_ROOT}/ok.sh' }] }] } }
  });
  const asked = [];
  await addAnything(src, { root, env, approve: async (s) => { asked.push(s); return true; } });
  assert.match(asked[0], /Cursor plugin "cursor-kit"/);
  assert.match(asked[0], /1 rule \(as skills\)/);
  assert.match(asked[0], /Cursor hooks run through the OASIS protocol bridge/);
  assert.match(asked[0], /Not carried over: Cursor hooks \(beforeTabFileRead\) have no matching OASIS event/);
  const plugins = await loadEnabledPlugins(root, { env });
  const skills = await pluginSkills(plugins);
  assert.deepEqual(skills.map((s) => s.name).sort(), ['cursor-kit-rule-style', 'review']);
  const { readFile } = await import('node:fs/promises');
  assert.match(await readFile(skills.find((s) => s.name === 'cursor-kit-rule-style').file, 'utf8'), /House style.*\*\*\/\*\.ts[\s\S]*Use named exports/);
  assert.equal((await servers(plugins, env, root)).kit.command, plugins[0].root + '/bin/kit');
  const hooks = Object.assign({}, ...(await pluginHooks(plugins, { env, root })).map((h) => h.hooks));
  assert.deepEqual(Object.keys(hooks), ['PreToolUse']);
  const bridged = hooks.PreToolUse.find((group) => group.hooks[0].protocol);
  assert.equal(bridged.matcher, 'Bash|PowerShell');
  assert.deepEqual(bridged.hooks[0], { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"', protocol: 'cursor', foreignEvent: 'beforeShellExecution' });
});

test('a Copilot CLI plugin (.github/plugin) installs with its root SKILL.md and .github/mcp.json', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.github/plugin/plugin.json': { name: 'copilot-kit', version: '2.0.0', description: 'Copilot' },
    'SKILL.md': '---\nname: deploy-check\ndescription: Check a deploy\n---\nCheck.\n',
    '.github/mcp.json': { mcpServers: { gh: { type: 'http', url: 'https://example.com/mcp' } } },
    'hooks.json': { version: 1, hooks: { preToolUse: [{ type: 'command', bash: './x.sh' }] } },
    'x.sh': '#!/bin/sh\n'
  });
  const asked = [];
  await addAnything(src, { root, env, approve: async (s) => { asked.push(s); return true; } });
  assert.match(asked[0], /Copilot CLI plugin "copilot-kit"/);
  assert.doesNotMatch(asked[0], /Not carried over/);
  const plugins = await loadEnabledPlugins(root, { env });
  assert.deepEqual((await pluginSkills(plugins)).map((s) => s.name), ['copilot-kit'], 'a root SKILL.md is the plugin\'s own skill');
  assert.deepEqual((await servers(plugins, env, root)).gh, { type: 'http', url: 'https://example.com/mcp' });
  const [hookSet] = await pluginHooks(plugins, { env, root });
  assert.deepEqual(hookSet.hooks.PreToolUse, [{ hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/x.sh"', protocol: 'copilot', foreignEvent: 'preToolUse', timeout: 30 }] }]);
});

test('a Kiro power installs: POWER.md and steering files become one skill, mcp.json servers start', async (t) => {
  const { src, root, env } = await fixture(t, {
    'POWER.md': '---\nname: "stripe-power"\ndisplayName: "Stripe"\ndescription: "Build payments with Stripe"\nkeywords: ["payments", "stripe"]\n---\n# Onboarding\nAsk for the API key first.\n',
    'steering/refunds.md': 'Refunds go through the refunds API.\n',
    'mcp.json': { mcpServers: { stripe: { url: 'https://mcp.stripe.com', type: 'http' } } }
  });
  const asked = [];
  await addAnything(src, { root, env, approve: async (s) => { asked.push(s); return true; } });
  assert.match(asked[0], /Kiro power "stripe-power"/);
  const plugins = await loadEnabledPlugins(root, { env });
  const [skill] = await pluginSkills(plugins);
  assert.equal(skill.name, 'stripe-power');
  const { readFile } = await import('node:fs/promises');
  const body = await readFile(skill.file, 'utf8');
  assert.match(body, /Build payments with Stripe.*payments, stripe/);
  assert.match(body, /Ask for the API key first/);
  assert.match(body, /steering\/refunds\.md/);
  assert.match(await readFile(path.join(path.dirname(skill.file), 'steering', 'refunds.md'), 'utf8'), /refunds API/);
  assert.equal((await servers(plugins, env, root)).stripe.url, 'https://mcp.stripe.com');
});

test('Cursor and Copilot marketplaces list their plugins and install the one picked', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.cursor-plugin/marketplace.json': { name: 'cursor-team', metadata: { pluginRoot: 'plugins' }, plugins: [{ name: 'alpha', source: 'alpha' }, { name: 'delta', source: 'delta' }, { name: 'escape', source: '../../x' }] },
    'plugins/delta/.cursor-plugin/plugin.json': { name: 'delta' },
    'plugins/alpha/.cursor-plugin/plugin.json': { name: 'alpha', description: 'A' },
    'plugins/alpha/skills/a/SKILL.md': '---\nname: a\ndescription: A\n---\nA.\n'
  });
  const listed = await addAnything(src, { root, env, approve: async () => true });
  assert.deepEqual(listed.available, ['alpha', 'delta']);
  assert.match(listed.message, /Cursor marketplace cursor-team has 2 plugins/);
  await addAnything(src + '#alpha', { root, env, approve: async () => true });
  assert.deepEqual((await loadEnabledPlugins(root, { env })).map((p) => p.name), ['alpha']);

  const copilot = await fixture(t, {
    '.github/plugin/marketplace.json': { name: 'gh-team', plugins: [{ name: 'beta', source: './beta' }] },
    'beta/.plugin/plugin.json': { name: 'beta', description: 'B' },
    'beta/agents/helper.md': '---\nname: helper\ndescription: Help\n---\nHelp.\n'
  });
  const picked = await addAnything(copilot.src + '#beta', { root: copilot.root, env: copilot.env, approve: async () => true });
  assert.match(picked.message, /Copilot CLI plugin/);
  assert.deepEqual((await loadEnabledPlugins(copilot.root, { env: copilot.env })).map((p) => p.name), ['beta']);
});

test('an OASIS marketplace (.oasis-plugin/marketplace.json) is read like a Claude Code one', async (t) => {
  const { src, root, env } = await fixture(t, {
    '.oasis-plugin/marketplace.json': { name: 'oasis-team', owner: { name: 'me' }, plugins: [{ name: 'gamma', source: './gamma' }] },
    'gamma/.oasis-plugin/plugin.json': { name: 'gamma', version: '0.0.1' },
    'gamma/skills/g/SKILL.md': '---\nname: g\ndescription: G\n---\nG.\n'
  });
  await addAnything(src + '#gamma', { root, env, approve: async () => true });
  const plugins = await loadEnabledPlugins(root, { env });
  assert.deepEqual(plugins.map((p) => p.name), ['gamma']);
  assert.deepEqual((await pluginSkills(plugins)).map((s) => s.name), ['g']);
  assert.equal((await validatePath(src)).ok, true);
});
