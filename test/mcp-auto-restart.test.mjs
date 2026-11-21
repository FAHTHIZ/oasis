import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectMcpServers, refreshSessionMcpTools, callMappedMcpTool, MAX_MCP_AUTO_RESTARTS } from '../src/mcp.mjs';

// ping answers with the server's pid; crash exits without answering.
const SERVER = [
  "let buffer = ''; process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result = {};",
  "    if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', serverInfo: { name: 'test', version: '1' }, capabilities: { tools: {} } };",
  "    if (m.method === 'tools/list') result = { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }, { name: 'crash', inputSchema: { type: 'object', properties: {} } }] };",
  "    if (m.method === 'tools/call' && m.params.name === 'crash') process.exit(3);",
  "    if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'pid ' + process.pid }] };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });"
].join('\n');

const text = (result) => JSON.stringify(result);
const waitFor = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('a crashed stdio MCP server restarts on its next call, a bounded number of times', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') };
  const { clients, failures } = await connectMcpServers({ env, skipUser: true, extraServers: [{ name: 'svc', command: process.execPath, args: ['-e', SERVER] }] });
  assert.equal(failures.length, 0);
  const session = { root: dir, mcpClients: clients, mcpFailures: [], toolDefinitions: [], allowedToolNames: new Set(), mcpHost: { session: null } };
  t.after(() => { for (const client of session.mcpClients.values()) client.close(); });
  refreshSessionMcpTools(session);
  const name = (tool) => [...session.mcpToolMap.keys()].find((key) => session.mcpToolMap.get(key).toolName === tool);

  const first = text(await callMappedMcpTool(session, name('ping'), {}, { autoApprove: true }));
  const pid1 = /pid (\d+)/.exec(first)[1];
  for (let round = 1; round <= MAX_MCP_AUTO_RESTARTS; round++) {
    await assert.rejects(callMappedMcpTool(session, name('crash'), {}, { autoApprove: true }), /restarted on the next call/);
    await waitFor(() => session.mcpClients.get('svc').exited);
    const again = text(await callMappedMcpTool(session, name('ping'), {}, { autoApprove: true }));
    assert.notEqual(/pid (\d+)/.exec(again)[1], pid1, 'a fresh process answered');
  }
  await assert.rejects(callMappedMcpTool(session, name('crash'), {}, { autoApprove: true }));
  await waitFor(() => session.mcpClients.get('svc').exited);
  await assert.rejects(callMappedMcpTool(session, name('ping'), {}, { autoApprove: true }), /already been restarted 3 times[\s\S]*\/mcp reconnect svc/);
});

test('a server closed on purpose is not restarted', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-norestart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') };
  const { clients } = await connectMcpServers({ env, skipUser: true, extraServers: [{ name: 'svc', command: process.execPath, args: ['-e', SERVER] }] });
  const session = { root: dir, mcpClients: clients, mcpFailures: [], toolDefinitions: [], allowedToolNames: new Set(), mcpHost: { session: null } };
  refreshSessionMcpTools(session);
  const ping = [...session.mcpToolMap.keys()].find((key) => session.mcpToolMap.get(key).toolName === 'ping');
  const client = session.mcpClients.get('svc');
  client.close();
  await waitFor(() => client.exited);
  await assert.rejects(callMappedMcpTool(session, ping, {}, { autoApprove: true }), /not running/);
  assert.equal(session.mcpClients.get('svc'), client);
});
