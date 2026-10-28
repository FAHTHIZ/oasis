import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServerClient } from '../src/mcp.mjs';
import { createMcpServeHandler, servedTools } from '../src/mcp-serve.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-serve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the tool set is read-only unless edits or commands are allowed', () => {
  const names = (options) => servedTools({ ...options, env: {} }).map((tool) => tool.name);
  assert.ok(names().includes('read_file') && names().includes('grep') && names().includes('lsp'));
  assert.ok(!names().includes('edit_file') && !names().includes('run_command') && !names().includes('delete_file'));
  assert.ok(names({ allowEdits: true }).includes('edit_file'));
  assert.ok(names({ allowCommands: true }).includes('run_command'));
  assert.ok(servedTools({ env: {} }).find((tool) => tool.name === 'read_file').annotations.readOnlyHint);
});

test('the handler answers MCP requests and keeps workspace safety rules', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'a.txt'), 'hello\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  const handle = createMcpServeHandler({ root, env: {} });
  t.after(() => handle.close());
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).result.serverInfo.name, 'oasis');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const read = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } });
  assert.match(read.result.content[0].text, /hello/);
  const secret = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: '.env' } } });
  assert.equal(secret.result.isError, true);
  const blocked = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'b.txt', content: 'x' } } });
  assert.match(blocked.error.message, /disabled tool/);
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
});

test('oasis mcp serve works with an MCP client over stdio', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  await writeFile(path.join(root, 'notes.md'), 'line one\nline two\n');
  const client = new McpServerClient({ name: 'oasis', command: process.execPath, args: [CLI, 'mcp', 'serve', '--allow-edits'], passEnv: [], enabled: true, cwd: root, extraEnv: { OASIS_CONFIG_DIR: home, HOME: home } }, { root, env: { ...process.env, OASIS_CONFIG_DIR: home, HOME: home } });
  t.after(() => client.close());
  const tools = await client.start();
  assert.ok(tools.some((tool) => tool.name === 'edit_file'));
  const result = await client.callTool('edit_file', { path: 'notes.md', old_string: 'line two', new_string: 'line 2' }, { autoApprove: true });
  assert.equal(result.isError, false);
  assert.equal(await readFile(path.join(root, 'notes.md'), 'utf8'), 'line one\nline 2\n');
});
