import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectMcpServers } from '../src/mcp.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

// Exits at once until the flag file exists, like a local server whose dependency was not running yet.
const FLAKY_SERVER = [
  "if (!require('node:fs').existsSync(process.argv[1])) process.exit(1);",
  "let buffer = ''; process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result = {};",
  "    if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} } };",
  "    if (m.method === 'tools/list') result = { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });"
].join('\n');

test('/mcp reconnect restarts a server that failed at startup and adds its tools', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const flag = path.join(dir, 'ready');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') };
  const config = { name: 'flaky', command: process.execPath, args: ['-e', FLAKY_SERVER, flag], env: { SECRET_TOKEN: 'do-not-leak' } };
  const { clients, failures } = await connectMcpServers({ env, skipUser: true, extraServers: [config] });
  assert.equal(clients.size, 0);
  assert.equal(failures.length, 1);
  assert.doesNotMatch(JSON.stringify(failures), /do-not-leak/, 'the saved config is not serialized');
  const session = { mcpClients: clients, mcpFailures: failures, toolDefinitions: [], allowedToolNames: new Set(), mcpHost: { session: null } };
  t.after(() => { for (const client of session.mcpClients.values()) client.close(); });

  const listed = await runBuiltinCommand('mcp', '', { root: dir, session, env });
  assert.match(listed.output, /flaky - not connected/);
  const still = await runBuiltinCommand('mcp', 'reconnect', { root: dir, session, env });
  assert.match(still.output, /^\[MCP\] flaky failed:/);
  assert.equal(session.mcpFailures.length, 1, 'a failed retry stays retryable');

  await writeFile(flag, 'ok');
  const ok = await runBuiltinCommand('mcp', 'reconnect flaky', { root: dir, session, env });
  assert.equal(ok.output, '[MCP] flaky reconnected · 1 tool(s)');
  assert.equal(session.mcpFailures.length, 0);
  const names = session.toolDefinitions.map((tool) => tool.function.name);
  assert.ok(names.some((name) => /flaky.*ping/.test(name)), names.join(','));
  assert.ok([...session.allowedToolNames].some((name) => /flaky.*ping/.test(name)));

  const again = await runBuiltinCommand('mcp', 'reconnect all', { root: dir, session, env });
  assert.equal(again.output, '[MCP] flaky reconnected · 1 tool(s)', 'connected servers can be restarted too');
  assert.match((await runBuiltinCommand('mcp', 'reconnect nope', { root: dir, session, env })).output, /nope failed: no MCP server with this name/);
});
