// Regressions found in live runs against real providers and servers (2026-11-08):
// OmniRoute as a gateway, slow free models, one-at-a-time 429s and MCP annotations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROVIDERS, providerForEndpoint, providerApiKey } from '../src/provider-registry.mjs';
import { LOCAL_SERVERS } from '../src/hardware.mjs';
import { priceFor } from '../src/pricing.mjs';
import { isUnconfiguredRouteError } from '../src/provider-retry.mjs';

test('omniroute is a built-in gateway, not a local model server', () => {
  const entry = BUILTIN_PROVIDERS.omniroute;
  assert.equal(entry.baseURL, 'http://127.0.0.1:20128/v1');
  assert.equal(entry.protocol, 'openai-compatible');
  assert.equal(entry.gateway, true);
  assert.ok(!LOCAL_SERVERS.some((server) => server.id === 'omniroute'), 'setup never recommends a gateway as a local model');
  assert.equal(providerForEndpoint('http://127.0.0.1:20128/v1', 'openai-compatible'), 'omniroute');
  assert.equal(providerApiKey('omniroute', { OMNIROUTE_API_KEY: 'sk-test' }), 'sk-test');
});

test('models behind OmniRoute are never priced as free local models', () => {
  const routed = priceFor('llm7/codestral-latest', { config: { baseURL: 'http://127.0.0.1:20128/v1' }, env: {} });
  assert.ok(!routed || !routed.local);
  const local = priceFor('qwen3:4b', { config: { baseURL: 'http://localhost:11434/v1' }, env: {} });
  assert.equal(local.local, true);
});

test('a gateway route with no account is not retried', () => {
  assert.equal(isUnconfiguredRouteError(503, '[503]: Devin agentic bridge is not configured: set DEVIN_AGENTIC_HOME'), true);
  assert.equal(isUnconfiguredRouteError(503, 'No active connections for provider auggie'), true);
  assert.equal(isUnconfiguredRouteError(503, 'The model is overloaded. Please try again later.'), false);
  assert.equal(isUnconfiguredRouteError(400, 'not configured'), false);
});

test('the error advice for an unconfigured gateway route says what to do', async () => {
  const { apiErrorAdvice } = await import('../src/api-error.mjs');
  assert.match(apiErrorAdvice(503, '[503]: Devin agentic bridge is not configured'), /no working account/);
  assert.match(apiErrorAdvice(503, 'overloaded'), /server-side problem/);
});

test('a one-request-at-a-time 429 waits briefly instead of failing', async () => {
  const { shortRateLimitMs } = await import('../src/provider-retry.mjs');
  assert.equal(shortRateLimitMs('{"error":{"code":"RATE_LIMITED","message":"Your previous request is still running. The Classic API answers 1 request at a time per IP."}}'), 5000);
  assert.equal(shortRateLimitMs('Too many concurrent requests'), 5000);
  assert.equal(shortRateLimitMs('Daily token quota exceeded'), null);
  assert.equal(shortRateLimitMs('concurrency limit reached; add billing credit'), null);
});

test('only read-only, closed-world tools from user MCP servers skip the auto-mode classifier', async () => {
  const { mcpToolDefinitions } = await import('../src/mcp.mjs');
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const tools = [
    { name: 'get-sum', inputSchema: { type: 'object' }, annotations: ro },
    { name: 'get-env', inputSchema: { type: 'object' }, annotations: ro },
    { name: 'fetch-page', inputSchema: { type: 'object' }, annotations: { ...ro, openWorldHint: true } },
    { name: 'toggle', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'plain', inputSchema: { type: 'object' } }
  ];
  const { map } = mcpToolDefinitions(new Map([['mine', { source: 'user', tools }], ['repo', { source: 'project', tools }]]));
  const readOnly = [...map].filter(([, entry]) => entry.readOnly).map(([id]) => id);
  assert.deepEqual(readOnly, ['mcp_mine_get-sum']);
});
