import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession } from '../src/agent.mjs';
import { loadSettings, setWorkspaceTrust } from '../src/settings.mjs';
import { mcpServerBlocked, approvedProjectServers } from '../src/mcp-policy.mjs';

const STDIO_SERVER = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result = {};",
  "    if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', serverInfo: { name: 'test', version: '1' }, capabilities: { tools: {} } };",
  "    if (m.method === 'tools/list') result = { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });"
].join('\n');

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t, { user, project, managed } = {}) {
  const root = await tmp(t);
  const home = await tmp(t);
  const server = { command: process.execPath, args: ['-e', STDIO_SERVER] };
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: server, beta: server, gamma: server } }));
  if (user) await writeFile(path.join(home, 'settings.json'), JSON.stringify(user));
  if (project) { await mkdir(path.join(root, '.claude'), { recursive: true }); await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(project)); }
  let managedFile = '';
  if (managed) { managedFile = path.join(home, 'managed-settings.json'); await writeFile(managedFile, JSON.stringify(managed)); }
  const env = { ...process.env, OASIS_CONFIG_DIR: home, HOME: home, CLAUDE_CONFIG_DIR: home, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: managedFile, OASIS_TRUST_WORKSPACE: '' };
  delete env.OASIS_TRUST_WORKSPACE;
  return { root, home, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' } };
}

async function open(t, f) {
  const session = await createSession({ root: f.root, config: f.config, env: f.env });
  t.after(() => closeSession(session));
  return session;
}

test('allowedMcpServers and deniedMcpServers match by name, command and URL pattern', () => {
  const stdio = { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] };
  const remote = { name: 'docs', url: 'https://mcp.example.com/v1/mcp' };
  const base = { denied: [], allowed: null, allowedManaged: null, managedOnly: false, rejected: [], approved: [] };
  assert.equal(mcpServerBlocked(stdio, base), '');
  assert.match(mcpServerBlocked(stdio, { ...base, denied: [{ serverName: 'FS' }] }), /deniedMcpServers/);
  assert.match(mcpServerBlocked(stdio, { ...base, allowed: [] }), /allowedMcpServers/, 'an empty allowlist blocks everything');
  assert.equal(mcpServerBlocked(stdio, { ...base, allowed: [{ serverName: 'fs' }] }), '');
  // Once a serverCommand entry exists, stdio servers must match a command, not just a name.
  assert.match(mcpServerBlocked(stdio, { ...base, allowed: [{ serverName: 'fs' }, { serverCommand: ['node', 'x.js'] }] }), /allowedMcpServers/);
  assert.equal(mcpServerBlocked(stdio, { ...base, allowed: [{ serverCommand: ['npx', '-y', '@modelcontextprotocol/server-filesystem'] }] }), '');
  assert.match(mcpServerBlocked(stdio, { ...base, allowed: [{ serverCommand: ['npx', '-y'] }] }), /allowedMcpServers/, 'commands match exactly');
  assert.equal(mcpServerBlocked(remote, { ...base, allowed: [{ serverUrl: 'https://*.example.com/*' }] }), '');
  assert.match(mcpServerBlocked(remote, { ...base, allowed: [{ serverUrl: 'https://other.com/*' }] }), /allowedMcpServers/);
  // A serverCommand entry does not stop a remote server matching by name.
  assert.equal(mcpServerBlocked(remote, { ...base, allowed: [{ serverName: 'docs' }, { serverCommand: ['node'] }] }), '');
  // The denylist wins over the allowlist.
  assert.match(mcpServerBlocked(remote, { ...base, allowed: [{ serverName: 'docs' }], denied: [{ serverUrl: 'https://mcp.example.com/*' }] }), /deniedMcpServers/);
  // allowManagedMcpServersOnly: only the managed allowlist counts.
  assert.match(mcpServerBlocked(stdio, { ...base, allowed: [{ serverName: 'fs' }], allowedManaged: [{ serverName: 'github' }], managedOnly: true }), /managed/);
});

test('approvedProjectServers applies rejections everywhere and approvals only when untrusted', () => {
  const servers = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const policy = { rejected: ['b'], approved: ['a'], approvedAll: undefined };
  assert.deepEqual(approvedProjectServers(servers, policy, { trusted: true }).servers.map((s) => s.name), ['a', 'c']);
  assert.deepEqual(approvedProjectServers(servers, policy, { trusted: false }).servers.map((s) => s.name), ['a']);
  assert.deepEqual(approvedProjectServers(servers, { ...policy, approvedAll: true }, { trusted: false }).servers.map((s) => s.name), ['a', 'c']);
});

test('settings scopes: approvals from project files are ignored in untrusted workspaces, denials are not', async (t) => {
  const f = await fixture(t, {
    user: { enabledMcpjsonServers: ['alpha'], allowedMcpServers: [{ serverName: 'alpha' }] },
    project: { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['beta'], disabledMcpjsonServers: ['gamma'], deniedMcpServers: [{ serverName: 'evil' }], allowedMcpServers: [{ serverName: 'beta' }] }
  });
  const settings = await loadSettings(f.root, { env: f.env });
  assert.equal(settings.trusted, false);
  assert.deepEqual(settings.mcpPolicy.approved, ['alpha']);
  assert.equal(settings.mcpPolicy.approvedAll, undefined);
  assert.deepEqual(settings.mcpPolicy.rejected, ['gamma']);
  assert.deepEqual(settings.mcpPolicy.denied, [{ serverName: 'evil' }]);
  assert.deepEqual(settings.mcpPolicy.allowed, [{ serverName: 'alpha' }]);
  assert.ok(!settings.ignoredUntrusted.length || settings.ignoredUntrusted.every((file) => file.endsWith('settings.json')));
});

test('enabledMcpjsonServers in user settings starts approved .mcp.json servers in an untrusted workspace', async (t) => {
  const f = await fixture(t, { user: { enabledMcpjsonServers: ['alpha'] } });
  const session = await open(t, f);
  assert.deepEqual([...session.mcpClients.keys()], ['alpha']);
  assert.ok(session.mcpFailures.some((item) => item.name === '.mcp.json' && /2 server\(s\) ignored/.test(item.error)));
});

test('enableAllProjectMcpServers in user settings approves every .mcp.json server; disabledMcpjsonServers still rejects', async (t) => {
  const f = await fixture(t, { user: { enableAllProjectMcpServers: true }, project: { disabledMcpjsonServers: ['beta'] } });
  const session = await open(t, f);
  assert.deepEqual([...session.mcpClients.keys()].sort(), ['alpha', 'gamma']);
});

test('approvals in the shared project settings do not start servers in an untrusted workspace', async (t) => {
  const f = await fixture(t, { project: { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['alpha'] } });
  const session = await open(t, f);
  assert.equal(session.mcpClients.size, 0);
  assert.ok(session.mcpFailures.some((item) => /not trusted/.test(item.error)));
});

test('trusted workspace: disabledMcpjsonServers rejects and managed deniedMcpServers blocks', async (t) => {
  const f = await fixture(t, { project: { disabledMcpjsonServers: ['alpha'] }, managed: { deniedMcpServers: [{ serverName: 'beta' }] } });
  await setWorkspaceTrust(f.root, true, f.env);
  const session = await open(t, f);
  assert.deepEqual([...session.mcpClients.keys()], ['gamma']);
  assert.ok(session.mcpFailures.some((item) => item.name === 'beta' && /deniedMcpServers/.test(item.error)));
  assert.ok(!session.toolDefinitions.some((tool) => tool.function.name === 'mcp_beta_ping'));
});

test('allowManagedMcpServersOnly ignores user allowlists', async (t) => {
  const f = await fixture(t, { user: { allowedMcpServers: [{ serverName: 'alpha' }, { serverName: 'beta' }] }, managed: { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverName: 'gamma' }] } });
  await setWorkspaceTrust(f.root, true, f.env);
  const session = await open(t, f);
  assert.deepEqual([...session.mcpClients.keys()], ['gamma']);
  assert.ok(session.mcpFailures.some((item) => item.name === 'alpha' && /allowedMcpServers \(managed settings\)/.test(item.error)));
});
