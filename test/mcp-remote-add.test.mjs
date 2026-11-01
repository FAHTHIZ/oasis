import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { addRemoteMcpServer, parseRemoteAddArgs } from '../src/mcp-remote-add.mjs';
import { loadUserMcpJson, loadProjectMcpServers } from '../src/mcp-project.mjs';
import { findHttpServer } from '../src/mcp-auth-commands.mjs';

async function dirs(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcpadd-root-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcpadd-home-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  return { root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: home, CLAUDE_CONFIG_DIR: home } };
}

test('Claude Code style arguments parse in any order', () => {
  assert.deepEqual(parseRemoteAddArgs(['--transport', 'sse', 'linear', 'https://mcp.linear.app/sse']), { name: 'linear', url: 'https://mcp.linear.app/sse', transport: 'sse', scope: 'user', headers: {} });
  assert.deepEqual(parseRemoteAddArgs(['docs', 'https://example.com/mcp', '--transport=http', '-H', 'X-Team: core', '--scope', 'project']).headers, { 'X-Team': 'core' });
  assert.throws(() => parseRemoteAddArgs(['--transport', 'websocket', 'a', 'wss://x']), /http or sse/);
  assert.throws(() => parseRemoteAddArgs(['--transport', 'http', 'only-name']), /Usage/);
  assert.throws(() => parseRemoteAddArgs(['--transport', 'http', 'a', 'https://x', '--header', 'novalue']), /Name: value/);
});

test('user scope writes ~/.config/oasis/mcp.json privately and the runtime loads it', async (t) => {
  const { root, env } = await dirs(t);
  const message = await addRemoteMcpServer(['--transport', 'sse', 'legacy', 'https://example.com/sse', '--header', 'Authorization: Bearer secret-value'], { root, env });
  assert.match(message, /Added MCP server "legacy" \(sse\)/);
  const loaded = await loadUserMcpJson({ env });
  assert.equal(loaded.servers[0].type, 'sse');
  assert.equal(loaded.servers[0].headers.Authorization, 'Bearer secret-value');
  if (process.platform !== 'win32') assert.equal((await stat(loaded.file)).mode & 0o777, 0o600);
  // oasis mcp login finds servers from the user file too.
  assert.equal((await findHttpServer(root, 'legacy', { env })).url, 'https://example.com/sse');
});

test('project scope refuses literal credentials and keeps other entries', async (t) => {
  const { root, env } = await dirs(t);
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'] } } }));
  await assert.rejects(addRemoteMcpServer(['--transport', 'http', 'api', 'https://example.com/mcp', '--scope', 'project', '-H', 'Authorization: Bearer abc123'], { root, env }), /usually committed/);
  const added = await addRemoteMcpServer(['--transport', 'http', 'api', 'https://example.com/mcp', '--scope', 'project', '-H', 'Authorization: Bearer ${API_TOKEN}'], { root, env });
  assert.match(added, /Set API_TOKEN before starting OASIS/);
  const saved = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.mcpServers), ['local', 'api']);
  assert.equal(saved.mcpServers.api.headers.Authorization, 'Bearer ${API_TOKEN}');
  const project = await loadProjectMcpServers(root, { env: { ...env, API_TOKEN: 't' } });
  assert.equal(project.servers.find((server) => server.name === 'api').headers.Authorization, 'Bearer t');
});

test('plain HTTP is refused for remote hosts and a declined prompt changes nothing', async (t) => {
  const { root, env } = await dirs(t);
  await assert.rejects(addRemoteMcpServer(['--transport', 'http', 'insecure', 'http://example.com/mcp'], { root, env }), /HTTPS/);
  const message = await addRemoteMcpServer(['--transport', 'http', 'later', 'http://127.0.0.1:3000/mcp'], { root, env, approve: async () => false });
  assert.match(message, /cancelled/);
  assert.deepEqual((await loadUserMcpJson({ env })).servers, []);
});
