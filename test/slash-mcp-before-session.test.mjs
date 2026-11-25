import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinCommand } from '../src/slash.mjs';

// The terminal starts its session with the first message; /mcp before then must not claim
// the configured servers are missing.
test('/mcp before the first message lists configured servers', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-pre-'));
  try {
    const dir = path.join(home, '.config', 'oasis');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'mcp-servers.json'), JSON.stringify({ servers: [{ name: 'alpha', command: 'node', args: ['x.js'], enabled: true, passEnv: [] }] }));
    await writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { beta: { type: 'http', url: 'https://example.com/mcp' } } }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_CONFIG_DIR: dir };
    const result = await runBuiltinCommand('mcp', '', { root: home, session: null, env });
    assert.match(result.output, /connect when you send your first message/);
    assert.match(result.output, /alpha/);
    assert.match(result.output, /beta/);
    assert.doesNotMatch(result.output, /No MCP servers are connected/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('/mcp before the first message with nothing set up says how to add one', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-none-'));
  try {
    const dir = path.join(home, '.config', 'oasis');
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_CONFIG_DIR: dir };
    const result = await runBuiltinCommand('mcp', '', { root: home, session: null, env });
    assert.match(result.output, /No MCP servers are set up/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
