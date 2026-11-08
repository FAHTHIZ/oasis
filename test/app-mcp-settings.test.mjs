import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { splitCommandLine, mcpServerFromForm, parseEnvNames, describeMcpServer } from '../app/core/mcp.mjs';
import { validateMcpServerConfig } from '../src/mcp.mjs';

test('splitCommandLine honours quotes and rejects unclosed ones', () => {
  assert.deepEqual(splitCommandLine('npx -y @scope/server "my dir" \'a b\' ""'), ['npx', '-y', '@scope/server', 'my dir', 'a b', '']);
  assert.deepEqual(splitCommandLine('   '), []);
  assert.throws(() => splitCommandLine('node "x'), /Close the " quote/);
});

test('mcpServerFromForm produces entries the runtime accepts', () => {
  const server = mcpServerFromForm({ name: ' GitHub ', command: 'npx -y @modelcontextprotocol/server-github', env: 'GITHUB_TOKEN, GITHUB_TOKEN' });
  assert.deepEqual(server, { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], passEnv: ['GITHUB_TOKEN'], enabled: true });
  assert.deepEqual(validateMcpServerConfig(server), server);
  assert.equal(describeMcpServer({ command: 'node', args: ['server.js', 'my dir'] }), 'node server.js "my dir"');
});

test('mcpServerFromForm explains bad input before it reaches the runtime', () => {
  assert.throws(() => mcpServerFromForm({ name: '1bad', command: 'npx x' }), /lowercase/);
  assert.throws(() => mcpServerFromForm({ name: 'ok', command: '' }), /command that starts/);
  assert.throws(() => mcpServerFromForm({ name: 'ok', command: '$(rm) x' }), /program name/);
  assert.throws(() => parseEnvNames('token=abc'), /uppercase/);
});

test('settings sheet ships the MCP section wired to the runtime API', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
  for (const id of ['mcpSettings', 'mcpList', 'mcpName', 'mcpCommand', 'mcpEnv', 'mcpAddButton', 'mcpStatus']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(main, /RT\.client\.api\('\/api\/mcp'\)/);
  assert.match(main, /method: 'POST', body: \{ servers: next \}/);
});

test('runtime welcome shows the hardware recommendation from /api/system/profile', async () => {
  const main = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /RT\.client\.api\('\/api\/system\/profile'\)/);
  assert.match(main, /Recommended for this computer/);
});
