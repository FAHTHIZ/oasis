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
