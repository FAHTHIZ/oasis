import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { query, tool } from 'oasis-oss';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-sdk-ctl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const env = (home) => ({ ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_AUTO_MEMORY: '0', OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: '' });

test('setModel() switches the model for the next request and "default" restores it', async (t) => {
  const root = await tmp(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'mcp_sdk_ping', {}),
    toolCall('c2', 'mcp_sdk_ping', {}),
    { content: 'done' }
  ]);
  let q;
  let pings = 0;
  const ping = tool('ping', 'Ping', { type: 'object', properties: {} }, async () => {
    pings += 1;
    if (pings === 1) await q.setModel('other-model');
    else await q.setModel('default');
    return 'pong';
  });
  q = query({ prompt: 'go', options: { cwd: root, provider: config, tools: [ping], settings, env: env(await tmp(t)) } });
  const events = [];
  for await (const event of q) events.push(event);
  assert.equal(events.at(-1).subtype, 'success');
  assert.deepEqual(requests.map((request) => request.model), [config.model, 'other-model', config.model]);
});

test('setModel() honours availableModels and rejects with the restriction message', async (t) => {
  const root = await tmp(t);
  const { config } = await scriptedModel(t, [toolCall('c1', 'mcp_sdk_ping', {}), { content: 'ok' }]);
  let q;
  let rejection = null;
  const ping = tool('ping', 'Ping', { type: 'object', properties: {} }, async () => {
    try { await q.setModel('forbidden-model'); } catch (error) { rejection = error; }
    return 'pong';
  });
  q = query({ prompt: 'go', options: { cwd: root, provider: config, tools: [ping], settings: { ...settings, availableModels: [config.model] }, env: env(await tmp(t)) } });
  for await (const event of q) void event;
  assert.ok(rejection, 'setModel should reject');
  assert.match(rejection.message, /forbidden-model/);
});

test('setPermissionMode() changes the live policy and validates mode names', async (t) => {
  const root = await tmp(t);
  const { config } = await scriptedModel(t, [toolCall('c1', 'mcp_sdk_ping', {}), { content: 'ok' }]);
  let q;
  let seen = '';
  let badError = null;
  let bypassError = null;
  const ping = tool('ping', 'Ping', { type: 'object', properties: {} }, async () => {
    await q.setPermissionMode('acceptEdits');
    seen = (await q.supportedModels()).map((item) => item.value).join(',');
    try { await q.setPermissionMode('yolo'); } catch (error) { badError = error; }
    try { await q.setPermissionMode('bypassPermissions'); } catch (error) { bypassError = error; }
    return 'pong';
  });
  q = query({ prompt: 'go', options: { cwd: root, provider: config, tools: [ping], settings: { ...settings, permissions: { ...settings.permissions, disableBypassPermissionsMode: true } }, env: env(await tmp(t)) } });
  for await (const event of q) void event;
  assert.deepEqual(await q.mcpServerStatus(), []);
  assert.match(String(badError && badError.message), /Unknown permission mode/);
  assert.match(String(bypassError && bypassError.message), /disableBypassPermissionsMode/);
  assert.ok(seen.includes(config.model));
});

test('setMaxThinkingTokens() sets a thinking budget on Anthropic requests and null resets it', async (t) => {
  const root = await tmp(t);
  const bodies = [];
  const replies = [
    [{ type: 'tool_use', id: 'c1', name: 'mcp_sdk_ping', input: {} }],
    [{ type: 'tool_use', id: 'c2', name: 'mcp_sdk_ping', input: {} }],
    [{ type: 'text', text: 'ok' }]
  ];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    const sent = JSON.parse(init.body);
    bodies.push(sent);
    const content = replies[Math.min(bodies.length - 1, replies.length - 1)];
    const message = { id: 'm' + bodies.length, type: 'message', role: 'assistant', model: sent.model, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    if (!sent.stream) return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
    const events = [['message_start', { type: 'message_start', message: { ...message, content: [] } }]];
    content.forEach((block, index) => {
      if (block.type === 'text') {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
      } else {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } }]);
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } }]);
      }
      events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    });
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 1 } }]);
    events.push(['message_stop', { type: 'message_stop' }]);
    const text = events.map(([name, data]) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n').join('');
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  let q;
  let pings = 0;
  const ping = tool('ping', 'Ping', { type: 'object', properties: {} }, async () => {
    pings += 1;
    await q.setMaxThinkingTokens(pings === 1 ? 4096 : null);
    return 'pong';
  });
  const provider = { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', apiKey: 'k' };
  q = query({ prompt: 'go', options: { cwd: root, provider, tools: [ping], settings, env: env(await tmp(t)) } });
  for await (const event of q) void event;
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].thinking, undefined);
  assert.deepEqual(bodies[1].thinking, { type: 'enabled', budget_tokens: 4096, display: 'summarized' });
  assert.equal(bodies[2].thinking, undefined);
  await assert.rejects(q.setMaxThinkingTokens(-1), /whole number/);
});

test('interrupt() aborts a running query', async (t) => {
  const root = await tmp(t);
  const { config } = await scriptedModel(t, [toolCall('c1', 'mcp_sdk_ping', {}), { content: 'never' }]);
  let q;
  const ping = tool('ping', 'Ping', { type: 'object', properties: {} }, async () => { await q.interrupt(); return 'pong'; });
  q = query({ prompt: 'go', options: { cwd: root, provider: config, tools: [ping], settings, env: env(await tmp(t)) } });
  const events = [];
  try { for await (const event of q) events.push(event); } catch (error) { events.push({ type: 'error', error }); }
  const last = events.at(-1);
  assert.ok(last.type === 'error' || (last.type === 'result' && last.subtype !== 'success'), JSON.stringify(last.type + ':' + last.subtype));
});
