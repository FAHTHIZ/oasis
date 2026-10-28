import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadClaudeCodeMcpServers } from '../src/mcp-project.mjs';

test('reads user and local scope MCP servers from ~/.claude.json', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-claude-mcp-'));
  const root = path.join(home, 'proj');
  await mkdir(root);
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${TOK}' } }, off: { command: 'x', disabled: true } },
    projects: { [root]: { mcpServers: { db: { command: 'node', args: ['db.js'], env: { DB_URL: 'pg://x' } } } }, '/other': { mcpServers: { nope: { command: 'n' } } } }
  }));
  const env = { HOME: home, TOK: 'abc' };
  const result = await loadClaudeCodeMcpServers(root, { env });
  assert.deepEqual(result.local.map((s) => s.name), ['db']);
  assert.equal(result.local[0].source, 'claude-local');
  assert.equal(result.local[0].extraEnv.DB_URL, 'pg://x');
  assert.deepEqual(result.user.map((s) => s.name), ['github']);
  assert.equal(result.user[0].headers.Authorization, 'Bearer abc');
  const ignored = await loadClaudeCodeMcpServers(root, { env: { ...env, OASIS_IGNORE_CLAUDE_MCP: '1' } });
  assert.equal(ignored.user.length, 0);
  const missing = await loadClaudeCodeMcpServers(root, { env: { HOME: path.join(home, 'none') } });
  assert.deepEqual(missing.failures, []);
});
