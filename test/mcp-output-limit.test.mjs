// MCP output follows MAX_MCP_OUTPUT_TOKENS (Claude Code's variable, default
// 25,000 tokens). It was a fixed 24,000 characters cut without a note, so a
// large document from a docs server silently lost its end.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { McpHttpClient, mcpOutputLimitChars } from '../src/mcp-project.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { mcpToolDefinitions } from '../src/mcp.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

test('MCP output limit comes from MAX_MCP_OUTPUT_TOKENS', () => {
  assert.equal(mcpOutputLimitChars({}), 100000);
  assert.equal(mcpOutputLimitChars({ MAX_MCP_OUTPUT_TOKENS: '50000' }), 200000);
  assert.equal(mcpOutputLimitChars({ OASIS_MAX_MCP_OUTPUT_TOKENS: '2000', MAX_MCP_OUTPUT_TOKENS: '50000' }), 8000);
  assert.equal(mcpOutputLimitChars({ MAX_MCP_OUTPUT_TOKENS: 'nope' }), 100000);
  assert.equal(mcpOutputLimitChars({ MAX_MCP_OUTPUT_TOKENS: '5' }), 4000);
});

test('a large MCP result keeps its head and tail with a note', async () => {
  const client = new McpHttpClient({ name: 'docs', url: 'http://127.0.0.1:9/mcp' }, { env: {} });
  client.tools = [{ name: 'read', inputSchema: { type: 'object' } }];
  const text = 'START' + 'x'.repeat(150000) + 'END';
  client._request = async () => ({ content: [{ type: 'text', text }] });
  const result = await client.callTool('read', {}, { autoApprove: true });
  assert.ok(result.content.length <= 100000);
  assert.ok(result.content.startsWith('START'));
  assert.ok(result.content.endsWith('END'));
  assert.match(result.content, /characters of MCP output omitted; set MAX_MCP_OUTPUT_TOKENS/);

  const small = new McpHttpClient({ name: 'docs', url: 'http://127.0.0.1:9/mcp' }, { env: {} });
  small.tools = client.tools;
  small._request = async () => ({ content: [{ type: 'text', text: 'y'.repeat(50000) }] });
  assert.equal((await small.callTool('read', {}, { autoApprove: true })).content.length, 50000);
});

test('the model sees more than 24,000 characters of an MCP result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [
    toolCall('m1', 'mcp_docs_read', {}),
    { content: 'done' }
  ]);
  // A 200K window: the result also has to fit a fifth of the window.
  const session = await createSession({ root, config: { ...config, contextWindow: 200_000 }, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  const body = 'A'.repeat(60000) + 'TAIL_MARKER';
  const client = {
    tools: [{ name: 'read', description: 'Read docs.', inputSchema: { type: 'object', properties: {} } }],
    toolFingerprints: new Map(),
    async callTool() { return { isError: false, content: body }; }
  };
  const clients = new Map([['docs', client]]);
  const dynamic = mcpToolDefinitions(clients);
  session.mcpClients = clients;
  session.mcpToolMap = dynamic.map;
  session.toolDefinitions = session.toolDefinitions.concat(dynamic.definitions);
  await runAgentTurn(session, 'Read the docs.', { approval: async () => true });
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage.content.length > 60000, 'length ' + toolMessage.content.length);
  assert.match(toolMessage.content, /TAIL_MARKER/);
});

test('an MCP call that asks for approval still gets the answer through the kernel', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-approve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [
    toolCall('m1', 'mcp_docs_read', {}),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  let prompts = 0;
  const client = {
    tools: [{ name: 'read', description: 'Read docs.', inputSchema: { type: 'object', properties: {} } }],
    toolFingerprints: new Map(),
    async callTool(_name, _args, options) {
      const ok = await options.approval('Call docs read?');
      return { isError: false, content: ok ? 'APPROVED_BODY' : 'denied' };
    }
  };
  const clients = new Map([['docs', client]]);
  const dynamic = mcpToolDefinitions(clients);
  session.mcpClients = clients;
  session.mcpToolMap = dynamic.map;
  session.toolDefinitions = session.toolDefinitions.concat(dynamic.definitions);
  await runAgentTurn(session, 'Read the docs.', { approval: async () => { prompts++; await new Promise((resolve) => setTimeout(resolve, 50)); return true; } });
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /APPROVED_BODY/);
  assert.ok(prompts >= 1);
});
