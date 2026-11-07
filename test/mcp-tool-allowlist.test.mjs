import test from 'node:test';
import assert from 'node:assert/strict';
import { toolAllowlist } from '../src/mcp-trust.mjs';

const tools = [
  { name: 'search_web' },
  { name: 'search_code' },
  { name: 'write_file' }
];

test('no allowlist allows all tools', () => {
  assert.equal(toolAllowlist('server', tools, {}).length, 3);
  assert.equal(toolAllowlist('server', tools, { mcp: { servers: {} } }).length, 3);
});

test('exact names filter tools', () => {
  const settings = { mcp: { servers: { server: { allowedTools: ['search_web'] } } } };
  const result = toolAllowlist('server', tools, settings);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'search_web');
});

test('wildcard patterns filter tools', () => {
  const settings = { mcp: { servers: { server: { allowedTools: ['search_*'] } } } };
  const result = toolAllowlist('server', tools, settings);
  assert.equal(result.length, 2);
  assert.ok(result.every((tool) => tool.name.startsWith('search_')));
});

test('empty allowlist allows all tools', () => {
  const settings = { mcp: { servers: { server: { allowedTools: [] } } } };
  assert.equal(toolAllowlist('server', tools, settings).length, 3);
});
