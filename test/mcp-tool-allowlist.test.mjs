import test from 'node:test';
import assert from 'node:assert/strict';
import { filterServerTools, normalizeToolFilter, serverToolFilters } from '../src/mcp-trust.mjs';
import { mcpToolDefinitions, validateMcpServerConfig } from '../src/mcp.mjs';
import { parseMcpServerEntries } from '../src/mcp-project.mjs';

const tools = [
  { name: 'search_web', inputSchema: { type: 'object', properties: {} } },
  { name: 'search_code', inputSchema: { type: 'object', properties: {} } },
  { name: 'write_file', inputSchema: { type: 'object', properties: {} } }
];
const names = (list) => list.map((tool) => tool.name);

test('no filter keeps every tool', () => {
  assert.deepEqual(names(filterServerTools(tools, {})), ['search_web', 'search_code', 'write_file']);
  assert.deepEqual(names(filterServerTools(tools, { allowedTools: [] })), ['search_web', 'search_code', 'write_file']);
  assert.deepEqual(names(filterServerTools(tools)), ['search_web', 'search_code', 'write_file']);
});

test('allowedTools keeps exact names and trailing-* prefixes', () => {
  assert.deepEqual(names(filterServerTools(tools, { allowedTools: ['search_web'] })), ['search_web']);
  assert.deepEqual(names(filterServerTools(tools, { allowedTools: ['search_*'] })), ['search_web', 'search_code']);
});

test('disabledTools removes tools and wins over allowedTools', () => {
  assert.deepEqual(names(filterServerTools(tools, { disabledTools: ['write_file'] })), ['search_web', 'search_code']);
  assert.deepEqual(names(filterServerTools(tools, { allowedTools: ['search_*'], disabledTools: ['search_code'] })), ['search_web']);
});

test('filter lists reject shell-like or mid-pattern wildcards and accept comma strings', () => {
  assert.deepEqual(normalizeToolFilter('a, b ,a'), ['a', 'b']);
  assert.throws(() => normalizeToolFilter(['se*rch']), /optionally ending in \*/);
  assert.throws(() => normalizeToolFilter(['two words']), /tool names/);
  assert.throws(() => normalizeToolFilter({}), /list/);
});

test('both Claude-style and Codex-style spellings are read', () => {
  assert.deepEqual(serverToolFilters({ allowedTools: ['a'] }), { allowedTools: ['a'] });
  assert.deepEqual(serverToolFilters({ enabled_tools: ['a'], disabled_tools: ['b'] }), { allowedTools: ['a'], disabledTools: ['b'] });
  assert.deepEqual(serverToolFilters({ enabledTools: ['a'], disabledTools: [] }), { allowedTools: ['a'] });
});

test('user mcp-servers.json entries keep their tool filters', () => {
  const checked = validateMcpServerConfig({ name: 'files', command: 'node', args: ['server.js'], allowedTools: ['read_*'], disabledTools: ['read_secret'] });
  assert.deepEqual(checked.allowedTools, ['read_*']);
  assert.deepEqual(checked.disabledTools, ['read_secret']);
  assert.throws(() => validateMcpServerConfig({ name: 'files', command: 'node', allowedTools: ['bad pattern'] }), /tool names/);
});

test('.mcp.json stdio and http entries keep their tool filters; a bad list is reported, not ignored', () => {
  const { servers, failures } = parseMcpServerEntries({ mcpServers: {
    local: { command: 'node', args: ['s.js'], disabled_tools: ['drop_table'] },
    remote: { url: 'https://mcp.example.com/mcp', allowedTools: ['search_*'] },
    broken: { command: 'node', allowedTools: 'a b' }
  } }, {});
  const byName = Object.fromEntries(servers.map((server) => [server.name, server]));
  assert.deepEqual(byName.local.disabledTools, ['drop_table']);
  assert.deepEqual(byName.remote.allowedTools, ['search_*']);
  assert.equal(byName.broken, undefined);
  assert.ok(failures.some((failure) => failure.name === 'broken' && /tool names/.test(failure.error)));
});

test('mcpToolDefinitions hides filtered tools from the model', () => {
  const clients = new Map([
    ['docs', { tools, config: { name: 'docs', allowedTools: ['search_*'], disabledTools: ['search_code'] }, source: 'user' }],
    ['open', { tools, config: { name: 'open' }, source: 'user' }]
  ]);
  const { definitions, map } = mcpToolDefinitions(clients);
  const exposed = definitions.map((definition) => definition.function.name).sort();
  assert.deepEqual(exposed, ['mcp_docs_search_web', 'mcp_open_search_code', 'mcp_open_search_web', 'mcp_open_write_file']);
  assert.equal(map.has('mcp_docs_write_file'), false);
});
