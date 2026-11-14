// MCP tool calls follow MCP_TOOL_TIMEOUT (Claude Code's variable) instead of a
// fixed two minutes, so a long build or query through MCP is not cut off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MCP_TOOL_TIMEOUT_MS, McpHttpClient, mcpToolTimeoutMs } from '../src/mcp-project.mjs';

test('MCP tool timeout comes from the environment', () => {
  assert.equal(mcpToolTimeoutMs({}), 120000);
  assert.equal(mcpToolTimeoutMs({ MCP_TOOL_TIMEOUT: '1800000' }), 1800000);
  assert.equal(mcpToolTimeoutMs({ OASIS_MCP_TOOL_TIMEOUT_MS: '600000', MCP_TOOL_TIMEOUT: '5' }), 600000);
  assert.equal(mcpToolTimeoutMs({ MCP_TOOL_TIMEOUT: 'nope' }), 120000);
  assert.equal(mcpToolTimeoutMs({ MCP_TOOL_TIMEOUT: String(10 * MAX_MCP_TOOL_TIMEOUT_MS) }), MAX_MCP_TOOL_TIMEOUT_MS);
});

test('callTool passes a long timeout through instead of clamping it to 15 minutes', async () => {
  const client = new McpHttpClient({ name: 'x', url: 'http://127.0.0.1:9/mcp' });
  client.tools = [{ name: 'build', inputSchema: { type: 'object' } }];
  let seen = 0;
  client._request = async (method, params, timeoutMs) => { seen = timeoutMs; return { content: [{ type: 'text', text: 'ok' }] }; };
  await client.callTool('build', {}, { autoApprove: true, timeoutMs: 1800000 });
  assert.equal(seen, 1800000);
});

test('the tool kernel keeps a long tool timeout instead of cutting it to 15 minutes', async () => {
  const { defineTool } = await import('../src/tool-kernel-core.mjs');
  const tool = defineTool({ name: 'long_tool', capabilities: ['mcp'], inputSchema: { type: 'object' }, run: async () => 'ok', timeoutMs: mcpToolTimeoutMs({ MCP_TOOL_TIMEOUT: '1800000' }) + 600000 });
  assert.equal(tool.timeoutMs, 2400000);
});
