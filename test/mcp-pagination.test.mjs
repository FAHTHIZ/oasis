// MCP lists are read across every nextCursor page, with no 80-tool cap, and a
// server that repeats a cursor cannot loop the client forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpHttpClient, parseMcpServerEntries } from '../src/mcp-project.mjs';

function pagedServer(t, { pages, loop = false }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'paged', version: '1' }, capabilities: { tools: {}, prompts: {} } };
    else if (message.method === 'tools/list' || message.method === 'prompts/list') {
      const key = message.method === 'tools/list' ? 'tools' : 'prompts';
      calls.push(message.method + ':' + (message.params && message.params.cursor || ''));
      const page = Number(message.params && message.params.cursor || 0);
      const items = Array.from({ length: 60 }, (_, i) => key === 'tools' ? { name: 't' + (page * 60 + i), inputSchema: { type: 'object', properties: {} } } : { name: 'p' + (page * 60 + i) });
      const next = loop ? '1' : page + 1 < pages ? String(page + 1) : undefined;
      result = { [key]: items, ...(next ? { nextCursor: next } : {}) };
    } else result = {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((done) => server.close(done)));
    resolve({ url: 'http://127.0.0.1:' + server.address().port + '/mcp', calls });
  }));
}

test('tools and prompts from every page are kept', async (t) => {
  const { url, calls } = await pagedServer(t, { pages: 4 });
  const client = new McpHttpClient({ name: 'paged', url });
  await client.start();
  t.after(() => client.close());
  assert.equal(client.tools.length, 240);
  assert.equal(client.tools.at(-1).name, 't239');
  assert.equal(client.prompts.length, 240);
  assert.deepEqual(calls.filter((c) => c.startsWith('tools/list')), ['tools/list:', 'tools/list:1', 'tools/list:2', 'tools/list:3']);
});

test('a repeated cursor ends the listing', async (t) => {
  const { url, calls } = await pagedServer(t, { pages: 1, loop: true });
  const client = new McpHttpClient({ name: 'loop', url });
  await client.start();
  t.after(() => client.close());
  assert.equal(calls.filter((c) => c.startsWith('tools/list')).length, 2);
  assert.equal(new Set(client.tools.map((tool) => tool.name)).size, client.tools.length);
});

test('more than 40 configured MCP servers are all loaded', () => {
  const mcpServers = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['s' + i, { type: 'http', url: 'https://mcp' + i + '.example/mcp' }]));
  const { servers } = parseMcpServerEntries({ mcpServers }, {});
  assert.equal(servers.length, 60);
});
