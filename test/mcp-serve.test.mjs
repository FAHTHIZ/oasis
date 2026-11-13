import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServerClient } from '../src/mcp.mjs';
import { PassThrough } from 'node:stream';
import { serveMcp, servedTools } from '../src/mcp-serve.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

// Drives the real stdio server over in-memory streams: one JSON-RPC message in,
// its reply (or null for a notification) out.
function createMcpServeHandler({ root, allowEdits = false, env = {} }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = new Map();
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const done = waiting.get(message.id);
      if (done) { waiting.delete(message.id); done(message); }
    }
  });
  const served = serveMcp({ root, args: allowEdits ? ['--allow-edits'] : [], env, input, output, log: { write() {} } });
  const handle = async (message) => {
    const reply = message.id === undefined ? null : new Promise((resolve) => waiting.set(message.id, resolve));
    input.write(JSON.stringify(message) + '\n');
    return reply;
  };
  handle.close = async () => { input.end(); await served; };
  return handle;
}

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
  const hello = (id, protocolVersion) => handle({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const init = await hello(1, '2025-11-25');
  assert.equal(init.result.serverInfo.name, 'oasis');
  // The SDK negotiates: the newest version is accepted, not pinned to one.
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal((await handle({ jsonrpc: '2.0', id: 11, method: 'ping' })).result && true, true);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const read = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } });
  assert.match(read.result.content[0].text, /hello/);
  const secret = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: '.env' } } });
  assert.equal(secret.result.isError, true);
  const blocked = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'b.txt', content: 'x' } } });
  assert.match(blocked.error.message, /disabled tool/);
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
  const older = createMcpServeHandler({ root, env: {} });
  t.after(() => older.close());
  assert.equal((await older({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '1' } } })).result.protocolVersion, '2024-11-05');
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

test('mcp serve refuses edits to protected config such as git hooks', async (t) => {
  // Regression: --allow-edits wrote .git/hooks/pre-commit with no check; the
  // agent itself always asks before that write.
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const root = await mkdtemp(pathMod.join(os.tmpdir(), 'oasis-serve-protected-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handle = createMcpServeHandler({ root, allowEdits: true, env: {} });
  t.after(() => handle.close());
  const call = (id, name, args) => handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  for (const [i, file] of ['.git/hooks/pre-commit', '.oasis/settings.json', '.mcp.json', '.vscode/tasks.json'].entries()) {
    const reply = await call(i + 1, 'write_file', { path: file, content: 'x' });
    assert.equal(reply.result.isError, true, file);
    assert.match(reply.result.content[0].text, /protected configuration/);
    assert.equal(existsSync(pathMod.join(root, file)), false, file);
  }
  const ok = await call(9, 'write_file', { path: 'notes.txt', content: 'x' });
  assert.equal(ok.result.isError, false);
  const allowed = createMcpServeHandler({ root, allowEdits: true, env: { OASIS_ALLOW_CONFIG_EDITS: '1' } });
  t.after(() => allowed.close());
  const opted = await allowed({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'write_file', arguments: { path: '.mcp.json', content: '{}' } } });
  assert.equal(opted.result.isError, false, 'OASIS_ALLOW_CONFIG_EDITS opts in');
});
