import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// An MCP server that takes ~800ms to answer initialize.
const SLOW_SERVER = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue;",
  "    if (m.method === 'initialize') { const id = m.id; setTimeout(() => reply(id, { protocolVersion: '2025-03-26', capabilities: { tools: {} } }), 800); }",
  "    else if (m.method === 'tools/list') reply(m.id, { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] });",
  "    else if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: 'pong' }] });",
  "    else reply(m.id, {}); } });"
].join('\n');

test('MCP_CONNECTION_NONBLOCKING starts the session before servers connect; wait_for_mcp_servers waits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcpnb-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcpnb-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { slow: { command: process.execPath, args: ['-e', SLOW_SERVER] } } }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home, HOME: home, MCP_CONNECTION_NONBLOCKING: 'true' };
  await setWorkspaceTrust(root, true, env);
  const { config, requests } = await scriptedModel(t, [
    toolCall('w1', 'wait_for_mcp_servers', { timeout_seconds: 20 }),
    toolCall('p1', 'mcp_slow_ping', {}),
    { content: 'done' }
  ]);
  const started = Date.now();
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  assert.ok(Date.now() - started < 700, 'session creation did not wait for the server');
  assert.ok(session.mcpConnecting);
  assert.ok(!session.toolDefinitions.some((tool) => tool.function.name === 'mcp_slow_ping'));
  await runAgentTurn(session, 'ping the slow server', { autoApprove: true, approval: async () => true });
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'wait_for_mcp_servers'));
  assert.match(JSON.stringify(requests[0].messages), /still connecting/);
  const tools = session.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[0], /"ready":\["slow"\]/);
  assert.match(tools[1], /pong/);
  assert.ok(requests[1].tools.some((tool) => tool.function.name === 'mcp_slow_ping'));
});

test('without the flag, wait_for_mcp_servers is hidden', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcpnb2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root }, settings: { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'hi');
  assert.ok(!requests[0].tools.some((tool) => tool.function.name === 'wait_for_mcp_servers'));
});
