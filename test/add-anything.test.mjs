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

test('an add-on that needs a key says so, and the key the user pastes is saved without reinstalling', async (t) => {
  const { addAnything } = await import('../src/add-anything.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-add-values-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, OASIS_CONFIG_DIR: path.join(base, 'cfg'), HOME: path.join(base, 'home') };
  const asked = [];
  const approve = async (s) => { asked.push(s); return true; };
  const first = await addAnything('npx docs-mcp --token ${DOCS_TOKEN}', { root: base, env, approve });
  assert.deepEqual(first.needs, { docs: ['DOCS_TOKEN'] });
  assert.match(first.message, /docs needs DOCS_TOKEN/);
  assert.match(first.agentHint, /source "docs" and env \{"DOCS_TOKEN": "\.\.\."\}/);
  const saved = await addAnything('docs', { root: base, env, values: { DOCS_TOKEN: 'sekret-1', EXTRA_FLAG: 'on' }, approve });
  assert.equal(saved.kind, 'configure');
  assert.equal(saved.reconnect, true);
  assert.match(asked[asked.length - 1], /^Save DOCS_TOKEN, EXTRA_FLAG for the MCP server "docs"/);
  assert.doesNotMatch(asked.join('\n'), /sekret-1/);
  const entry = JSON.parse(await readFile(path.join(base, 'cfg', 'mcp.json'), 'utf8')).mcpServers.docs;
  assert.deepEqual(entry.args, ['-y', 'docs-mcp', '--token', 'sekret-1']);
  assert.deepEqual(entry.env, { EXTRA_FLAG: 'on' });
  if (process.platform !== 'win32') assert.equal((await stat(path.join(base, 'cfg', 'mcp.json'))).mode & 0o777, 0o600);
  const declined = await addAnything('docs', { root: base, env, values: { DOCS_TOKEN: 'x' }, approve: async () => false });
  assert.equal(declined.approved, false);
  // Values given with the install are applied straight away.
  const once = await addAnything('npx other-mcp --key ${OTHER_KEY}', { root: base, env, values: { OTHER_KEY: 'k2' }, approve });
  assert.equal(once.needs, undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(base, 'cfg', 'mcp.json'), 'utf8')).mcpServers.other.args.slice(-1), ['k2']);
  // A remote server gets a pasted token as its Authorization header.
  await addAnything('https://mcp.example.com/mcp', { root: base, env, name: 'remote', approve });
  await addAnything('remote', { root: base, env, values: { GITHUB_TOKEN: 'ghp_1' }, approve });
  await addAnything('remote', { root: base, env, values: { 'X-Api-Key': 'k3' }, approve });
  assert.deepEqual(JSON.parse(await readFile(path.join(base, 'cfg', 'mcp.json'), 'utf8')).mcpServers.remote.headers, { Authorization: 'Bearer ghp_1', 'X-Api-Key': 'k3' });
});

test('an MCP server installed from the chat starts in that chat and its tool works straight away', async (t) => {
  const SERVER = [
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
    "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
    "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
    "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue;",
    "    if (m.method === 'initialize') reply(m.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} } });",
    "    else if (m.method === 'tools/list') reply(m.id, { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] });",
    "    else if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: 'pong from ' + process.env.PING_NAME }] });",
    "    else reply(m.id, {}); } });"
  ].join('\n');
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-add-live-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj');
  await mkdir(root);
  const serverFile = path.join(base, 'ping-server.cjs');
  await writeFile(serverFile, SERVER);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg'), HOME: path.join(base, 'home'), PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  const { config, requests } = await scriptedModel(t, [
    toolCall('a1', 'add_extension', { source: 'claude mcp add -e PING_NAME=oasis pinger -- node ' + serverFile }),
    toolCall('p1', 'mcp_pinger_ping', {}),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const asked = [];
  await runAgentTurn(session, 'install this: claude mcp add pinger -- node ' + serverFile, { env, autoApprove: true, approval: async (q) => { asked.push(q); return true; } });
  assert.equal(asked.filter((q) => /pinger/.test(q)).length, 1);
  const results = session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.match(results[0], /"started":\["pinger"\]/);
  assert.match(results[1], /pong from oasis/);
  assert.ok(requests[1].tools.some((tool) => tool.function.name === 'mcp_pinger_ping') || /mcp_pinger_ping/.test(JSON.stringify(requests[1])));
});

test('a plugin installed from the chat brings its skills and MCP servers into that same chat', async (t) => {
  const SERVER = "let b='';process.stdin.setEncoding('utf8');const r=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');process.stdin.on('data',(c)=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);let m;try{m=JSON.parse(l)}catch{continue}if(m.id===undefined)continue;if(m.method==='initialize')r(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}}});else if(m.method==='tools/list')r(m.id,{tools:[{name:'ping',description:'Ping',inputSchema:{type:'object',properties:{}}}]});else if(m.method==='tools/call')r(m.id,{content:[{type:'text',text:'plugin pong'}]});else r(m.id,{})}});";
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-add-plugin-live-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj');
  const plugin = path.join(base, 'toolkit');
  await mkdir(root);
  await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(plugin, 'skills', 'deploy-check'), { recursive: true });
  await writeFile(path.join(plugin, 'server.cjs'), SERVER);
  await writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'toolkit', version: '1.0.0', mcpServers: { tk: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.cjs'] } } }));
  await writeFile(path.join(plugin, 'skills', 'deploy-check', 'SKILL.md'), '---\nname: deploy-check\ndescription: Check a deploy\n---\nRun the deploy checklist.\n');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg'), HOME: path.join(base, 'home'), PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  const { config } = await scriptedModel(t, [
    toolCall('a1', 'add_extension', { source: plugin }),
    toolCall('s1', 'load_skill', { name: 'deploy-check' }),
    toolCall('p1', 'mcp_tk_ping', {}),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'install ' + plugin, { env, autoApprove: true, approval: async () => true });
  const results = session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.match(results[0], /"started":\["tk"\]/);
  assert.match(results[0], /usable now with load_skill: deploy-check/);
  assert.match(results[1], /Run the deploy checklist/);
  assert.match(results[2], /plugin pong/);
});

test('"Add to Cursor" and "Install in VS Code" links install the server they describe', async () => {
  const { classifySource: c } = await import('../src/add-anything.mjs');
  const b64 = Buffer.from(JSON.stringify({ command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { DEFAULT_MINIMUM_TOKENS: '1000' } })).toString('base64');
  const cursor = c('cursor://anysphere.cursor-deeplink/mcp/install?name=context7&config=' + encodeURIComponent(b64));
  assert.equal(cursor.kind, 'stdio-mcp'); assert.equal(cursor.name, 'context7'); assert.deepEqual(cursor.args, ['-y', '@upstash/context7-mcp']); assert.deepEqual(cursor.env, { DEFAULT_MINIMUM_TOKENS: '1000' });
  const web = c('https://cursor.com/en/install-mcp?name=linear&config=' + encodeURIComponent(Buffer.from(JSON.stringify({ url: 'https://mcp.linear.app/sse' })).toString('base64')));
  assert.equal(web.kind, 'remote-mcp'); assert.equal(web.name, 'linear'); assert.equal(web.transport, 'sse');
  const vscode = c('vscode:mcp/install?' + encodeURIComponent(JSON.stringify({ name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'] })));
  assert.equal(vscode.name, 'playwright'); assert.deepEqual(vscode.args, ['-y', '@playwright/mcp@latest']);
  const redirect = c('https://insiders.vscode.dev/redirect/mcp/install?name=github&config=' + encodeURIComponent(JSON.stringify({ type: 'http', url: 'https://api.githubcopilot.com/mcp/' })));
  assert.equal(redirect.kind, 'remote-mcp'); assert.equal(redirect.name, 'github'); assert.equal(redirect.transport, 'http');
  assert.throws(() => c('cursor://anysphere.cursor-deeplink/mcp/install?name=x&config=%%%'), /no readable MCP server config/);
});
