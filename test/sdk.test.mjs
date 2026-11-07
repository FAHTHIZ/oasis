import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { query, run, tool, createToolServer } from 'oasis-oss';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-sdk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const env = (home) => ({ ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_AUTO_MEMORY: '0' });

test('query streams events and runs in-process tools', async (t) => {
  const root = await tmp(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'mcp_sdk_weather', { city: 'Dhaka' }),
    { content: 'Sunny in Dhaka, picnic is on.' }
  ]);
  const calls = [];
  const weather = tool('weather', 'Current weather for a city', { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, async ({ city }) => { calls.push(city); return { city, forecast: 'sunny' }; });
  const events = [];
  for await (const event of query({ prompt: 'Plan a picnic', options: { cwd: root, provider: config, tools: [weather], settings, env: env(await tmp(t)) } })) events.push(event);
  assert.deepEqual(calls, ['Dhaka']);
  assert.deepEqual(events.map((event) => event.type), ['system', 'tool_use', 'tool_result', 'assistant', 'result']);
  assert.ok(events[0].tools.includes('mcp_sdk_weather'));
  assert.match(events[2].content, /sunny/);
  assert.equal(events.at(-1).subtype, 'success');
  assert.equal(events.at(-1).result, 'Sunny in Dhaka, picnic is on.');
  assert.match(requests[0].tools.map((item) => item.function.description).join('\n'), /Current weather for a city/);
});

test('canUseTool decides approvals, and run() returns the result with structured output', async (t) => {
  const root = await tmp(t);
  const { config } = await scriptedModel(t, [
    toolCall('c1', 'mcp_ops_deploy', { target: 'prod' }),
    toolCall('c2', 'mcp_ops_deploy', { target: 'staging' }),
    { content: '{"deployed": ["staging"]}' }
  ]);
  const deployed = [];
  const ops = createToolServer('ops', [tool('deploy', 'Deploy a build', { type: 'object', properties: { target: { type: 'string' } } }, async ({ target }) => { deployed.push(target); return 'deployed ' + target; }, { needsApproval: true })]);
  const asked = [];
  const result = await run('Deploy', {
    cwd: root, provider: config, tools: [ops], settings, env: env(await tmp(t)),
    jsonSchema: { type: 'object', properties: { deployed: { type: 'array', items: { type: 'string' } } }, required: ['deployed'] },
    canUseTool: async (toolName, input) => { asked.push([toolName, input.target]); return input.target === 'prod' ? { behavior: 'deny' } : true; }
  });
  assert.deepEqual(deployed, ['staging']);
  assert.deepEqual(asked, [['mcp_ops_deploy', 'prod'], ['mcp_ops_deploy', 'staging']]);
  assert.deepEqual(result.structured_output, { deployed: ['staging'] });
  assert.equal(result.permission_denials.length, 1);
});

test('tool() validates its arguments', () => {
  assert.throws(() => tool('bad name!', 'x', {}, async () => {}), /Tool names/);
  assert.throws(() => tool('ok', 'x', {}, null), /run\(input\)/);
});

test('breaking out of query() early stops the agent instead of leaving it running', async (t) => {
  const root = await tmp(t);
  const calls = [];
  const slow = tool('slow', 'Waits a moment', { type: 'object', properties: { n: { type: 'number' } } }, async ({ n }) => { calls.push(n); await new Promise((resolve) => setTimeout(resolve, 50)); return { ok: n }; });
  const script = Array.from({ length: 40 }, (_, i) => toolCall('c' + i, 'mcp_sdk_slow', { n: i }));
  const { config, requests } = await scriptedModel(t, script);
  for await (const event of query({ prompt: 'loop', options: { cwd: root, provider: config, tools: [slow], settings, autoApprove: true, env: env(await tmp(t)) } })) {
    if (event.type === 'tool_result') break;
  }
  const seen = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(requests.length <= seen + 1, 'the agent kept calling the model after the consumer stopped: ' + seen + ' -> ' + requests.length);
  assert.ok(calls.length <= 2, 'the agent kept running tools: ' + calls.length);
});

test('SDK tools validate JSON Schema before executing', async () => {
  let calls = 0;
  const server = createToolServer('validation', [
    tool('lookup', 'Look up a city', {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false
    }, async () => { calls++; return { ok: true }; })
  ]);
  await assert.rejects(() => server.callTool('lookup', {}, { autoApprove: true }), /missing required property "city"/i);
  await assert.rejects(() => server.callTool('lookup', { city: 42 }, { autoApprove: true }), /expected string/i);
  await assert.rejects(() => server.callTool('lookup', { city: 'Dhaka', extra: true }, { autoApprove: true }), /unexpected property/i);
  assert.equal(calls, 0);
});

test('SDK tool execution observes timeout and caller cancellation', async () => {
  let timeoutObserved = false;
  const timeoutServer = createToolServer('timeouts', [
    tool('slow', 'A slow task', { type: 'object' }, async (_input, { signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', () => { timeoutObserved = true; resolve(); }, { once: true }));
      return 'finished';
    }, { timeoutMs: 20 })
  ]);
  await assert.rejects(() => timeoutServer.callTool('slow', {}, { autoApprove: true }), /Tool timed out/);
  assert.equal(timeoutObserved, true);

  let cancelObserved = false;
  const cancelServer = createToolServer('cancellation', [
    tool('wait', 'A cancellable task', { type: 'object' }, async (_input, { signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', () => { cancelObserved = true; resolve(); }, { once: true }));
      return 'finished';
    }, { timeoutMs: 2000 })
  ]);
  const controller = new AbortController();
  const pending = cancelServer.callTool('wait', {}, { autoApprove: true, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error('SDK caller cancelled'));
  await assert.rejects(() => pending, /SDK caller cancelled/);
  assert.equal(cancelObserved, true);
});

test('SDK tool registries reject duplicate tool names', () => {
  const one = tool('same', 'First', { type: 'object' }, async () => 'one');
  const two = tool('same', 'Second', { type: 'object' }, async () => 'two');
  assert.throws(() => createToolServer('duplicates', [one, two]), /Duplicate SDK tool name/);
});

test('SDK approval prompts and audit callbacks redact credential values', async () => {
  const credential = 'sk-secret-token-123456';
  let approvalMessage = '';
  let audit = null;
  const server = createToolServer('secure', [
    tool('publish', 'Publish a change', {
      type: 'object',
      properties: { token: { type: 'string' } },
      required: ['token']
    }, async () => 'published', { needsApproval: true })
  ]);
  const result = await server.callTool('publish', { token: credential }, {
    approval: async (message) => { approvalMessage = message; return true; },
    onAudit: (record) => { audit = record; }
  });
  assert.equal(result, 'published');
  assert.doesNotMatch(approvalMessage, /sk-secret-token-123456/);
  assert.ok(audit);
  assert.equal(audit.input.token, '[redacted]');
});

test('SDK tools validate declared output schemas before returning results', async () => {
  const server = createToolServer('output-validation', [
    tool('valid_result', 'Returns a typed result', { type: 'object' }, async () => ({
      count: 3,
      label: 'ready'
    }), {
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' }, label: { type: 'string' } },
        required: ['count', 'label'],
        additionalProperties: false
      }
    }),
    tool('invalid_result', 'Returns an invalid result', { type: 'object' }, async () => ({
      message: 'finished'
    }), {
      outputSchema: { type: 'object', required: ['status'] }
    })
  ]);
  assert.deepEqual(await server.callTool('valid_result', {}, { autoApprove: true }), {
    count: 3,
    label: 'ready'
  });
  await assert.rejects(
    () => server.callTool('invalid_result', {}, { autoApprove: true }),
    /Invalid output from invalid_result.*missing required property "status"/i
  );
  assert.deepEqual(
    server.tools.find((item) => item.name === 'valid_result').outputSchema.required,
    ['count', 'label']
  );
});
