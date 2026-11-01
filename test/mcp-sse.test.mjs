import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpSseClient, parseMcpServerEntries } from '../src/mcp-project.mjs';
import { connectMcpServers, closeMcpClients } from '../src/mcp.mjs';

// A legacy HTTP+SSE MCP server: GET /sse streams events, POST /messages?sessionId=… accepts JSON-RPC.
async function sseServer(t, { endpoint = (id) => '/messages?sessionId=' + id, requireAuth = null, inlineReply = false } = {}) {
  const streams = new Map();
  const received = [];
  let nextSession = 1;
  const server = createServer(async (req, res) => {
    if (requireAuth && req.headers.authorization !== requireAuth) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/sse') {
      const id = String(nextSession++);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: endpoint\ndata: ' + endpoint(id) + '\n\n');
      streams.set(id, res);
      req.on('close', () => streams.delete(id));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      received.push(message);
      const stream = streams.get(url.searchParams.get('sessionId'));
      if (!stream) { res.writeHead(404); res.end(); return; }
      let reply = null;
      if (message.method === 'initialize') reply = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      else if (message.method === 'tools/list') reply = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
      else if (message.method === 'tools/call') reply = { content: [{ type: 'text', text: 'echo: ' + message.params.arguments.text }] };
      else if (message.method === 'slow/never') { res.writeHead(202); res.end(); return; }
      else if (message.id !== undefined) reply = {};
      const body = message.id === undefined ? null : { jsonrpc: '2.0', id: message.id, result: reply };
      if (body && inlineReply) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return; }
      res.writeHead(202); res.end('Accepted');
      if (body) stream.write('event: message\ndata: ' + JSON.stringify(body) + '\n\n');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const res of streams.values()) res.destroy(); return new Promise((resolve) => server.close(resolve)); });
  return { url: 'http://127.0.0.1:' + server.address().port + '/sse', received, streams };
}

test('.mcp.json accepts "type": "sse" servers', () => {
  const { servers, failures } = parseMcpServerEntries({ mcpServers: { legacy: { type: 'sse', url: 'https://example.com/sse', headers: { 'X-Key': 'k' } } } });
  assert.deepEqual(failures, []);
  assert.equal(servers[0].type, 'sse');
  assert.equal(servers[0].url, 'https://example.com/sse');
  const bad = parseMcpServerEntries({ mcpServers: { x: { type: 'websocket', url: 'https://example.com' } } });
  assert.match(bad.failures[0].error, /stdio, http or sse/);
});

test('an SSE MCP server connects, lists tools and runs a call', async (t) => {
  const fixture = await sseServer(t);
  const client = new McpSseClient({ name: 'legacy', url: fixture.url });
  t.after(() => client.close());
  const tools = await client.start();
  assert.deepEqual(tools.map((tool) => tool.name), ['echo']);
  const result = await client.callTool('echo', { text: 'hi' }, { autoApprove: true });
  assert.equal(result.content, 'echo: hi');
  assert.ok(fixture.received.some((message) => message.method === 'notifications/initialized'));
});

test('replies sent inline in the POST response are accepted too', async (t) => {
  const fixture = await sseServer(t, { inlineReply: true });
  const client = new McpSseClient({ name: 'inline', url: fixture.url });
  t.after(() => client.close());
  await client.start();
  assert.equal((await client.callTool('echo', { text: 'x' }, { autoApprove: true })).content, 'echo: x');
});

test('headers from the config go on the stream and on each message', async (t) => {
  const fixture = await sseServer(t, { requireAuth: 'Bearer abc' });
  const client = new McpSseClient({ name: 'authed', url: fixture.url, headers: { Authorization: 'Bearer abc' } });
  t.after(() => client.close());
  await client.start();
  assert.equal(client.tools.length, 1);
  const denied = new McpSseClient({ name: 'denied', url: fixture.url, headers: { Authorization: 'Bearer wrong' } });
  t.after(() => denied.close());
  await assert.rejects(denied.start(), /rejected the credentials \(HTTP 401\)/);
});

test('an endpoint on another origin is refused', async (t) => {
  const fixture = await sseServer(t, { endpoint: () => 'https://evil.example/messages' });
  const client = new McpSseClient({ name: 'redirect', url: fixture.url });
  t.after(() => client.close());
  await assert.rejects(client.start(), /different origin/);
});

test('pending calls fail cleanly when the stream drops', async (t) => {
  const fixture = await sseServer(t);
  const client = new McpSseClient({ name: 'drop', url: fixture.url });
  t.after(() => client.close());
  await client.start();
  const pending = client._request('slow/never', {}, 5000);
  for (const res of fixture.streams.values()) res.destroy();
  await assert.rejects(pending, /closed its SSE stream|terminated|other side closed/);
});

test('connectMcpServers starts sse servers from project config', async (t) => {
  const fixture = await sseServer(t);
  const { clients, failures } = await connectMcpServers({ skipUser: true, extraServers: [{ name: 'legacy', type: 'sse', url: fixture.url, headers: {} }] });
  t.after(() => closeMcpClients(clients));
  assert.deepEqual(failures, []);
  assert.ok(clients.get('legacy') instanceof McpSseClient);
  assert.equal(clients.get('legacy').tools[0].name, 'echo');
});
