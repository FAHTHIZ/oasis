import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { addMarketplace, installPlugin, uninstallPlugin, loadEnabledPlugins, pluginMcpServers } from '../src/claude-plugins.mjs';
import { loadAgentDefinitions } from '../src/subagents.mjs';
import { createEvidenceLedger, evidenceFromToolResult, recordEvidence } from '../src/evidence-ledger.mjs';
import { checkReport } from '../src/verification-contracts.mjs';

// Roadmap 2.5: the research and analysis packs install through the normal
// plugin path, their agents declare the domain their reports are checked
// against, and removing a pack leaves OASIS as it was.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function market(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-packs-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_PLUGIN_DIRS: '', OASIS_PLUGINS: '' };
  const dir = path.join(base, 'market');
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  for (const pack of ['oasis-research', 'oasis-analysis']) await cp(path.join(repo, 'plugins', pack), path.join(dir, 'plugins', pack), { recursive: true });
  await writeFile(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'packs', owner: { name: 'Test' }, plugins: [{ name: 'oasis-research', source: './plugins/oasis-research' }, { name: 'oasis-analysis', source: './plugins/oasis-analysis' }] }));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  await addMarketplace(dir, { env, cwd: root });
  return { env, root };
}

function rpc(command, args, env, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP server timed out: ' + err)); }, 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const lines = out.split('\n').filter(Boolean);
      if (lines.length >= messages.length) { clearTimeout(timer); child.kill(); resolve(lines.map((line) => JSON.parse(line))); }
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error('MCP server exited ' + code + ': ' + err)); } });
    for (const message of messages) child.stdin.write(JSON.stringify(message) + '\n');
  });
}

test('both packs install through the plugin path with domain-checked agents, and uninstall cleanly', async (t) => {
  const { env, root } = await market(t);
  const before = await loadAgentDefinitions(root, { env });
  const research = await installPlugin('oasis-research@packs', { env, root });
  const analysis = await installPlugin('oasis-analysis@packs', { env, root });
  assert.deepEqual(research.summary.agents.sort(), ['oasis-research:fact-checker', 'oasis-research:researcher']);
  assert.deepEqual(research.summary.mcpServers, ['oasis-research']);
  assert.deepEqual(analysis.summary.agents, ['oasis-analysis:analyst']);
  const agents = await loadAgentDefinitions(root, { env });
  assert.deepEqual(agents['oasis-research:researcher'].domains, ['research']);
  assert.deepEqual(agents['oasis-research:fact-checker'].domains, ['research']);
  assert.deepEqual(agents['oasis-analysis:analyst'].domains, ['analysis']);
  for (const tool of ['write_file', 'edit_file', 'run_command']) assert.ok(agents['oasis-research:researcher'].disallowedTools.includes(tool), 'research agents cannot write or run commands: ' + tool);

  // The installed copy lives in the plugin cache, away from OASIS's src/, and still starts.
  const [{ mcpServers }] = (await pluginMcpServers(await loadEnabledPlugins(root, { env }), { env, root })).filter((item) => item.mcpServers['oasis-research']);
  const spec = mcpServers['oasis-research'];
  assert.equal(spec.env.OASIS_PACKAGE_ROOT, repo);
  assert.ok(!spec.args[0].startsWith(path.join(repo, 'plugins')), 'the server runs from the installed copy');
  const replies = await rpc(process.execPath, spec.args, { ...env, ...spec.env }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  ]);
  assert.deepEqual(replies[1].result.tools.map((tool) => tool.name), ['oasis_web_search', 'oasis_fetch_url', 'oasis_search_status']);

  await uninstallPlugin('oasis-research', { env });
  await uninstallPlugin('oasis-analysis', { env });
  assert.deepEqual(Object.keys(await loadAgentDefinitions(root, { env })).sort(), Object.keys(before).sort(), 'removing the packs restores the agent list');
});

test('the research contract counts pages read through the pack tools', () => {
  const ledger = createEvidenceLedger();
  const search = evidenceFromToolResult('mcp__oasis-research__oasis_web_search', { query: 'node sqlite' }, { isError: false, content: JSON.stringify({ results: [{ url: 'https://nodejs.org/api/sqlite.html' }, { url: 'https://example.com/blog' }] }) });
  assert.deepEqual(search.urls, ['https://nodejs.org/api/sqlite.html', 'https://example.com/blog']);
  recordEvidence(ledger, search);
  const fetched = evidenceFromToolResult('mcp__oasis-research__oasis_fetch_url', { url: 'https://nodejs.org/api/sqlite.html' }, { isError: false, content: JSON.stringify({ url: 'https://nodejs.org/api/sqlite.html', status: 200, text: 'Stability: 1.1 - Active development' }) });
  assert.equal(fetched.kind, 'fetch');
  recordEvidence(ledger, fetched);
  assert.equal(evidenceFromToolResult('mcp__oasis-research__oasis_fetch_url', { url: 'https://down.example' }, { isError: true, content: 'MCP tool reported an error:\n{"error":"timeout"}' }), null);
  // A clipped search result still yields its URLs.
  assert.deepEqual(evidenceFromToolResult('mcp__x__oasis_web_search', {}, { content: '{"results": [{"url": "https://a.example/x", "title": "cut' }).urls, ['https://a.example/x']);

  const good = 'node:sqlite is still in active development ([Node docs](https://nodejs.org/api/sqlite.html)).';
  assert.deepEqual(checkReport(good, ledger.events, { domains: ['research'] }), []);
  const bad = good + ' A blog agrees: https://example.com/blog';
  const issues = checkReport(bad, ledger.events, { domains: ['research'] });
  assert.equal(issues.length, 1);
  assert.match(issues[0].reason, /never fetched .*example\.com\/blog.*only appeared in search results/);
});
