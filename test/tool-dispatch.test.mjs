import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDispatch } from '../src/tool-dispatch.mjs';

const definition = { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {}, required: ['path'] } } };
const executor = async (call) => ({ path: call.arguments.path, content: 'ok' });
const policy = { decide: () => ({ decision: 'allow' }) };

test('dispatch executes allowed tools and returns normalized output', async () => {
  const dispatch = createToolDispatch(executor, { definition, policy });
  const result = await dispatch({ name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) }, {});
  assert.equal(result.ok, true);
  assert.equal(result.output.content, 'ok');
  assert.equal(result.audit.tool, 'read_file');
});

test('dispatch denies when policy denies', async () => {
  const denyPolicy = { decide: () => ({ decision: 'deny', reason: 'not allowed' }) };
  const dispatch = createToolDispatch(executor, { definition, policy: denyPolicy });
  const result = await dispatch({ name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not allowed');
});

test('dispatch validates required input', async () => {
  const dispatch = createToolDispatch(executor, { definition, policy });
  const result = await dispatch({ name: 'read_file', arguments: '{}' }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing required input/);
});

test('dispatch redacts secrets in audit records', async () => {
  const dispatch = createToolDispatch(executor, { definition, policy });
  const result = await dispatch({ name: 'read_file', arguments: JSON.stringify({ path: 'README.md', token: 'sk-secret-token-123456' }) }, {});
  assert.equal(result.ok, true);
  assert.match(result.audit.input.token, /\[redacted\]/);
  assert.doesNotMatch(result.audit.input.token, /sk-secret-token-123456/);
});
