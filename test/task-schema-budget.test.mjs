import test from 'node:test';
import assert from 'node:assert/strict';
import { taskToolDefinition } from '../src/subagents.mjs';

test('task tool schema stays compact with many custom agents', () => {
  const agents = {};
  for (let i = 0; i < 40; i++) agents['agent' + i] = { name: 'agent' + i, description: 'Reviews code carefully. '.repeat(25), tools: null };
  const definition = taskToolDefinition(agents);
  assert.ok(JSON.stringify(definition).length < 6000, 'schema should be capped');
  assert.match(definition.function.description, /- agent0: Reviews code/);
  assert.match(definition.function.description, /…and \d+ more \(.*agent39\)/);
  assert.equal(definition.function.parameters.properties.subagent_type.enum.length, 40, 'every agent is still selectable');
});

test('task tool schema lists small agent sets in full', () => {
  const definition = taskToolDefinition({ a: { name: 'a', description: 'Alpha agent', tools: ['read_file'] } });
  assert.match(definition.function.description, /- a: Alpha agent \(tools: read_file\)/);
  assert.doesNotMatch(definition.function.description, /more \(/);
});
