import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const workspace = process.argv[2];
const moduleUrl = pathToFileURL(path.join(workspace, 'src', 'mcp.mjs')).href;
const { loadMcpServers } = await import(moduleUrl);
const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-bounds-'));
try {
  const configPath = path.join(root, 'mcp-servers.json');
  const server = { name: 'fixture', command: process.execPath, args: [], passEnv: [], enabled: false };

  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, servers: [server, { ...server }] }));
  await assert.rejects(loadMcpServers({ configPath }), /MCP server names must be unique/);

  const servers = Array.from({ length: 41 }, (_, index) => ({ ...server, name: 'server-' + index }));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, servers }));
  await assert.rejects(loadMcpServers({ configPath }), /supports up to 40 servers/);

  await writeFile(configPath, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(loadMcpServers({ configPath }), /larger than 1 MiB/);

  await rm(configPath, { force: true });
  assert.deepEqual((await loadMcpServers({ configPath })).servers, []);
} finally {
  await rm(root, { recursive: true, force: true });
}
