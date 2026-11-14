import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshSessionMcpTools } from '../src/mcp.mjs';
import { deferMcpTools, searchTools } from '../src/session-tools.mjs';

const client = (name, tools) => ({ config: { name }, source: 'user', tools: tools.map((tool) => ({ name: tool, description: tool + ' tool', inputSchema: { type: 'object', properties: {} } })), capabilities: { tools: {} } });

// A refresh (a server starting, reconnecting or changing its tools) used to put
// every MCP schema back into the prompt even when tool_search had deferred them.
test('refreshing MCP tools keeps deferred tools deferred and loaded tools loaded', () => {
  const session = { mcpClients: new Map([['a', client('a', ['one', 'two', 'three'])]]), toolDefinitions: [{ type: 'function', function: { name: 'read_file' } }], allowedToolNames: new Set() };
  refreshSessionMcpTools(session);
  assert.equal(deferMcpTools(session, { threshold: 1, env: {} }), 3);
  searchTools(session, { query: 'select:mcp_a_one' });
  const names = () => session.toolDefinitions.map((tool) => tool.function.name);
  assert.deepEqual(names(), ['read_file', 'tool_search', 'mcp_a_one']);

  session.mcpClients.set('b', client('b', ['four']));
  refreshSessionMcpTools(session);
  assert.deepEqual(names(), ['read_file', 'tool_search', 'mcp_a_one']);
  assert.deepEqual([...session.deferredTools.keys()].sort(), ['mcp_a_three', 'mcp_a_two', 'mcp_b_four']);
  assert.ok(session.allowedToolNames.has('mcp_b_four'));

  // A tool that disappears leaves both lists.
  session.mcpClients.set('a', client('a', ['two']));
  refreshSessionMcpTools(session);
  assert.deepEqual(names(), ['read_file', 'tool_search']);
  assert.deepEqual([...session.deferredTools.keys()].sort(), ['mcp_a_two', 'mcp_b_four']);
});

test('without deferral, a refresh still adds every tool directly', () => {
  const session = { mcpClients: new Map([['a', client('a', ['one'])]]), toolDefinitions: [], allowedToolNames: new Set() };
  refreshSessionMcpTools(session);
  session.mcpClients.set('b', client('b', ['two']));
  refreshSessionMcpTools(session);
  assert.deepEqual(session.toolDefinitions.map((tool) => tool.function.name), ['mcp_a_one', 'mcp_b_two']);
});
