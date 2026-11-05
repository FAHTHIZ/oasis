import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { classifySource, inspectAddonDirectory, addAnything } from '../src/add-anything.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function tmp(t, prefix = 'oasis-add-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const write = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
const isolatedEnv = (dir) => ({ ...process.env, HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), OASIS_CONFIG_DIR: path.join(dir, 'config'), XDG_CONFIG_HOME: path.join(dir, 'home', '.config') });

test('classifySource recognises every kind of source people paste', () => {
  const kind = (s) => classifySource(s).kind;
  assert.equal(kind('obra/superpowers'), 'repo');
  assert.equal(kind('https://github.com/anthropics/skills/tree/main/skills/pdf'), 'repo');
  assert.deepEqual((({ ref, subdir }) => ({ ref, subdir }))(classifySource('https://github.com/anthropics/skills/tree/main/skills/pdf')), { ref: 'main', subdir: 'skills/pdf' });
  assert.equal(classifySource('owner/repo#v1.2.0').ref, 'v1.2.0');
  assert.equal(classifySource('owner/repo#my-skill').pick, 'my-skill');
  assert.equal(kind('commit-commands@claude-code-plugins'), 'plugin-spec');
  assert.deepEqual((({ kind: k, transport }) => ({ k, transport }))(classifySource('https://mcp.linear.app/sse')), { k: 'remote-mcp', transport: 'sse' });
  assert.equal(classifySource('https://mcp.context7.com/mcp').transport, 'http');
  assert.equal(kind('@playwright/mcp'), 'npm-mcp');
  assert.equal(kind('io.github.github/github-mcp-server'), 'registry');
  assert.equal(kind('context7'), 'search');
  assert.equal(kind('./plugins/mine'), 'repo');
  assert.throws(() => classifySource('https://user:pw@github.com/a/b'), /credentials/);
  assert.throws(() => classifySource(''), /Tell OASIS what to add/);
});

test('inspectAddonDirectory tells plugins, marketplaces, skills and MCP servers apart, and skips maintainer-only skills', async (t) => {
  const dir = await tmp(t);
  await write(path.join(dir, 'a', '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'm', owner: { name: 'x' }, plugins: [{ name: 'one', source: './one' }] }));
  await write(path.join(dir, 'b', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'solo' }));
  await write(path.join(dir, 'b', 'commands', 'hi.md'), 'Say hi');
  await write(path.join(dir, 'c', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: PDFs\n---\nUse it.');
  await write(path.join(dir, 'd', 'package.json'), JSON.stringify({ name: 'demo-mcp', dependencies: { '@modelcontextprotocol/sdk': '1' } }));
  await write(path.join(dir, 'd', '.claude', 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: maintainers\n---\n');
  await write(path.join(dir, 'e', 'src', 'memory', 'package.json'), JSON.stringify({ name: '@x/server-memory', dependencies: { '@modelcontextprotocol/sdk': '1' } }));
  await write(path.join(dir, 'e', '.claude', 'skills', 'triage', 'SKILL.md'), '---\nname: triage\ndescription: maintainers\n---\n');
  assert.equal((await inspectAddonDirectory(path.join(dir, 'a'))).type, 'marketplace');
  const solo = await inspectAddonDirectory(path.join(dir, 'b'));
  assert.equal(solo.type, 'claude-plugin');
  assert.deepEqual(solo.contents, ['1 commands']);
  assert.deepEqual(await inspectAddonDirectory(path.join(dir, 'c')), { type: 'skills', skills: ['pdf'] });
  assert.equal((await inspectAddonDirectory(path.join(dir, 'd'))).type, 'mcp-server');
  assert.deepEqual(await inspectAddonDirectory(path.join(dir, 'e')), { type: 'mcp-collection', servers: [{ name: 'memory', npmName: '@x/server-memory' }] });
});

test('a local Claude Code plugin folder installs and enables in one step', async (t) => {
  const dir = await tmp(t);
  const env = isolatedEnv(dir);
  const plugin = path.join(dir, 'hello-plugin');
  await write(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hello', description: 'Says hello' }));
  await write(path.join(plugin, 'commands', 'hello.md'), '---\ndescription: Greet\n---\nSay hello.');
  const asked = [];
  const result = await addAnything(plugin, { root: dir, env, approve: async (summary) => { asked.push(summary); return true; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Claude Code plugin "hello".*1 commands/);
  assert.equal(result.kind, 'claude-plugin');
  assert.match(result.installed[0], /^hello@repo-/);
  assert.match(result.message, /Installed and enabled hello@/);
});

test('a local marketplace installs the plugin named after #', async (t) => {
  const dir = await tmp(t);
  const env = isolatedEnv(dir);
  const market = path.join(dir, 'market');
  await write(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'demo-market', owner: { name: 'me' }, plugins: [{ name: 'alpha', source: './plugins/alpha' }, { name: 'beta', source: './plugins/beta' }] }));
  for (const name of ['alpha', 'beta']) await write(path.join(market, 'plugins', name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  const result = await addAnything(market + '#beta', { root: dir, env, approve: async () => true });
  assert.deepEqual(result.installed, ['beta@demo-market']);
  const listOnly = await addAnything(market, { root: dir, env, approve: async () => true });
  assert.deepEqual(listOnly.installed, []);
  assert.match(listOnly.message, /Available: alpha, beta/);
});

test('skills install from a folder, remote MCP URLs are configured, and a "no" changes nothing', async (t) => {
  const dir = await tmp(t);
  const env = isolatedEnv(dir);
  const skills = path.join(dir, 'skills-repo');
  await write(path.join(skills, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Work with PDF files.\n---\nSteps.');
  const denied = await addAnything(skills, { root: dir, env, approve: async () => false });
  assert.equal(denied.approved, false);
  assert.match(denied.message, /Nothing was installed/);
  const result = await addAnything(skills, { root: dir, env, approve: async () => true });
  assert.deepEqual(result.installed, ['pdf']);
  assert.ok(await stat(path.join(env.HOME, '.config', 'agents', 'skills', 'pdf', 'SKILL.md')));
  const mcp = await addAnything('https://mcp.example.test/mcp', { root: dir, env, approve: async () => true });
  assert.equal(mcp.kind, 'remote-mcp');
  const saved = JSON.parse(await readFile(path.join(env.OASIS_CONFIG_DIR, 'mcp.json'), 'utf8'));
  assert.deepEqual(saved.mcpServers.example, { type: 'http', url: 'https://mcp.example.test/mcp' });
});

test('the agent installs what the user pastes with add_extension after one approval, even with --yes', async (t) => {
  const dir = await tmp(t);
  const env = isolatedEnv(dir);
  const skills = path.join(dir, 'skills-repo');
  await write(path.join(skills, 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Tidy code.\n---\nSteps.');
  const { config, requests } = await scriptedModel(t, [
    toolCall('a1', 'add_extension', { source: skills }),
    { content: 'Installed.' }
  ]);
  const session = await createSession({ root: dir, config, env, settings: { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } } });
  t.after(() => closeSession(session));
  assert.match(session.messages[0].content, /add_extension/);
  const prompts = [];
  await runAgentTurn(session, 'install this ' + skills, { autoApprove: true, approval: async (text) => { prompts.push(text); return true; } });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Install the skill tidy[\s\S]*Install it now\?/);
  const tool = session.messages.find((m) => m.role === 'tool');
  assert.deepEqual(JSON.parse(tool.content).installed, ['tidy']);
  assert.ok(requests.length >= 2);
});

test('/add installs straight from the command and asks for a source when empty', async (t) => {
  const dir = await tmp(t);
  const env = isolatedEnv(dir);
  assert.match((await runBuiltinCommand('add', '', { root: dir, env })).output, /Usage: \/add LINK/);
  const out = await runBuiltinCommand('add', 'https://mcp.example.test/sse', { root: dir, env });
  assert.match(out.output, /remote MCP server "example" \(sse\)[\s\S]*Added MCP server "example"/);
});

test('install commands and pages copied from READMEs are understood', async () => {
  const { classifySource: c } = await import('../src/add-anything.mjs');
  const pick = (s) => { const r = c(s); delete r.display; return r; };
  assert.deepEqual(pick('npx -y @playwright/mcp@latest'), { kind: 'stdio-mcp', name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} });
  assert.deepEqual(pick('npx firecrawl-mcp').args, ['-y', 'firecrawl-mcp']);
  assert.equal(pick('uvx mcp-server-fetch').name, 'fetch');
  assert.equal(pick('docker run -i --rm ghcr.io/github/github-mcp-server').name, 'github');
  assert.deepEqual(pick('claude mcp add -e API_KEY=abc --scope user airtable -- npx -y airtable-mcp-server'), { kind: 'stdio-mcp', name: 'airtable', command: 'npx', args: ['-y', 'airtable-mcp-server'], env: { API_KEY: 'abc' } });
  assert.equal(pick('codex mcp add docs -- npx -y docs-mcp').name, 'docs');
  assert.deepEqual(pick('gemini mcp add fs npx -y @modelcontextprotocol/server-filesystem .').args.slice(-1), ['.']);
  const remote = pick('claude mcp add --transport sse -H "Authorization: Bearer x" linear https://mcp.linear.app/sse');
  assert.equal(remote.kind, 'remote-mcp'); assert.equal(remote.name, 'linear'); assert.equal(remote.transport, 'sse'); assert.deepEqual(remote.headers, ['Authorization: Bearer x']);
  assert.equal(pick('/plugin marketplace add anthropics/claude-code').owner, 'anthropics');
  assert.equal(pick('/plugin install commit-commands@claude-code-plugins').spec, 'commit-commands@claude-code-plugins');
  assert.equal(pick('claude plugin install commit-commands@claude-code-plugins --scope project').spec, 'commit-commands@claude-code-plugins');
  assert.equal(pick('npx skills add anthropics/skills --skill pdf').pick, 'pdf');
  assert.equal(pick('$ npx skills add https://github.com/vercel-labs/agent-skills').name, 'agent-skills');
  assert.equal(pick('https://skills.sh/anthropics/skills/pdf').pick, 'pdf');
  assert.equal(pick('https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md').subdir, 'skills/pdf');
  assert.equal(pick('https://www.npmjs.com/package/@playwright/mcp').pkg, '@playwright/mcp');
  assert.equal(pick('https://pypi.org/project/mcp-server-fetch/').command, 'uvx');
  assert.equal(pick('https://smithery.ai/server/@upstash/context7-mcp').pkg, '@upstash/context7-mcp');
  assert.equal(pick('git@github.com:obra/superpowers.git').owner, 'obra');
  assert.equal(pick('`obra/superpowers`').name, 'superpowers');
  assert.throws(() => c('npx "unclosed'), /quote/);
});

test('a pasted stdio command is written as-is after one approval', async (t) => {
  const { addAnything } = await import('../src/add-anything.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-add-stdio-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg') };
  const asked = [];
  const result = await addAnything('claude mcp add -e TOKEN=t1 docs -- npx docs-mcp --port 0', { root: base, env, approve: async (s) => { asked.push(s); return true; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /TOKEN set/);
  assert.doesNotMatch(asked[0], /t1/);
  const saved = JSON.parse(await readFile(path.join(base, 'cfg', 'mcp.json'), 'utf8'));
  assert.deepEqual(saved.mcpServers.docs, { command: 'npx', args: ['-y', 'docs-mcp', '--port', '0'], env: { TOKEN: 't1' } });
  assert.deepEqual(result.installed, ['docs']);
});

test('Gemini and Codex install commands are understood too', async () => {
  const { classifySource: c } = await import('../src/add-anything.mjs');
  assert.equal(c('gemini extensions install https://github.com/gemini-cli-extensions/security').owner, 'gemini-cli-extensions');
  assert.equal(c('gemini extensions install github.com/user/repo --ref v2.0.0').ref, 'v2.0.0');
  assert.equal(c('gemini extensions install https://github.com/a/b --auto-update --consent').name, 'b');
  assert.equal(c('codex plugin marketplace add openai/plugins').owner, 'openai');
  assert.equal(c('codex plugin marketplace add acme/mono --ref v2.1.0').name, 'mono');
});
