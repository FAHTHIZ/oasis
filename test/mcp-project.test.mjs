import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { loadProjectMcpServers, McpHttpClient, expandVariables } from '../src/mcp-project.mjs';
import { connectMcpServers, closeMcpClients, mcpToolDefinitions } from '../src/mcp.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';

const STDIO_SERVER = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result = {};",
  "    if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} } };",
  "    if (m.method === 'tools/list') result = { tools: [{ name: 'whoami', inputSchema: { type: 'object', properties: {} } }] };",
  "    if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'got ' + process.env.PROJECT_TOKEN }] };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });"
].join('\n');

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcpp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('variables expand with defaults and missing ones fail clearly', () => {
  assert.equal(expandVariables('Bearer ${T}', { T: 'abc' }), 'Bearer abc');
  assert.equal(expandVariables('${NOPE:-x}', {}), 'x');
  assert.throws(() => expandVariables('${NOPE}', {}), /NOPE is not set/);
});

test('.mcp.json stdio servers start with expanded env; bad entries are reported', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    'My-Server': { command: process.execPath, args: ['-e', STDIO_SERVER], env: { PROJECT_TOKEN: '${SECRET_FOR_TEST}' } },
    broken: { type: 'sse', url: 'https://x.example/sse' },
    missing: { type: 'http', url: 'https://x.example/${UNSET_VAR}' },
    off: { command: 'nothing', disabled: true }
  } }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home, SECRET_FOR_TEST: 's3cret' };
  const project = await loadProjectMcpServers(root, { env });
  assert.deepEqual(project.servers.map((s) => s.name), ['my-server']);
  assert.deepEqual(project.failures.map((f) => f.name).sort(), ['broken', 'missing']);
  const mcp = await connectMcpServers({ root, env, extraServers: project.servers });
  t.after(() => closeMcpClients(mcp.clients));
  assert.deepEqual(mcp.failures, []);
  const client = mcp.clients.get('my-server');
  assert.equal(client.source, 'project');
  const out = await client.callTool('whoami', {}, { autoApprove: true });
  assert.equal(out.content, 'got s3cret');
  assert.equal(mcpToolDefinitions(mcp.clients).definitions[0].function.name, 'mcp_my-server_whoami');
});

test('Streamable HTTP client handles JSON and SSE replies, session ids, and approvals', async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.method === 'DELETE') { seen.push({ method: 'DELETE', session: req.headers['mcp-session-id'] }); res.end(); return; }
    const message = JSON.parse(body);
    seen.push({ method: message.method, session: req.headers['mcp-session-id'], auth: req.headers.authorization });
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    if (message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }));
      return;
    }
    const result = message.method === 'tools/list'
      ? { tools: [{ name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: 'found ' + message.params.arguments.q }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
    res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await tmp(t);
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'http://127.0.0.1:' + server.address().port + '/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } } } }));
  const { servers } = await loadProjectMcpServers(root, { env: { REMOTE_TOKEN: 'tok' } });
  const client = new McpHttpClient(servers[0]);
  await client.start();
  assert.deepEqual(client.tools.map((tool) => tool.name), ['search']);
  const denied = await client.callTool('search', { q: 'x' }, { approval: async () => false });
  assert.equal(denied.approved, false);
  const result = await client.callTool('search', { q: 'docs' }, { approval: async () => true });
  assert.equal(result.content, 'found docs');
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seen[0].auth, 'Bearer tok');
  assert.equal(seen[0].session, undefined);
  assert.ok(seen.slice(1).every((entry) => entry.session === 'sess-1'));
  assert.equal(seen.at(-1).method, 'DELETE');
});

test('remote MCP over plain HTTP is rejected, and untrusted workspaces ignore .mcp.json', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { a: { type: 'http', url: 'http://example.com/mcp' }, b: { command: process.execPath, args: ['-e', STDIO_SERVER] } } }));
  const loaded = await loadProjectMcpServers(root, { env: {} });
  assert.match(loaded.failures[0].error, /HTTPS/);
  const env = { ...process.env, OASIS_CONFIG_DIR: home, HOME: home };
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' };
  const untrusted = await createSession({ root, config, env });
  t.after(() => closeSession(untrusted));
  assert.equal(untrusted.mcpClients.size, 0);
  assert.ok(untrusted.mcpFailures.some((f) => /not trusted/.test(f.error)));
  await setWorkspaceTrust(root, true, env);
  const trusted = await createSession({ root, config, env });
  t.after(() => closeSession(trusted));
  assert.ok(trusted.mcpClients.has('b'));
  assert.ok(trusted.toolDefinitions.some((tool) => tool.function.name === 'mcp_b_whoami'));
});
