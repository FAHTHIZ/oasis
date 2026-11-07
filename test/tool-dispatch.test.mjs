import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDispatch } from '../src/tool-dispatch.mjs';

const definition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};
const executor = async (call) => ({ path: JSON.parse(call.arguments).path, content: 'ok' });
const policy = { decide: () => ({ decision: 'allow' }) };

test('dispatch executes allowed tools through the shared kernel', async () => {
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
  assert.match(result.error, /missing required property/i);
});

test('dispatch redacts secrets in audit records', async () => {
  const dispatch = createToolDispatch(executor, { definition, policy });
  const result = await dispatch({
    name: 'read_file',
    arguments: JSON.stringify({ path: 'README.md', token: 'sk-secret-token-123456' })
  }, {});
  assert.equal(result.ok, true);
  assert.equal(result.audit.input.token, '[redacted]');
  assert.doesNotMatch(JSON.stringify(result.audit), /sk-secret-token-123456/);
});

test('dispatch refuses mismatched tool definitions before executing anything', async () => {
  let calls = 0;
  const dispatch = createToolDispatch(async () => { calls++; return 'ran'; }, {
    definition,
    policy
  });
  const result = await dispatch({ name: 'delete_file', arguments: '{"path":"important.txt"}' }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match/i);
  assert.equal(calls, 0);
});

test('dispatch refuses missing definitions and malformed argument JSON', async () => {
  let calls = 0;
  const execute = async () => { calls++; return 'ran'; };
  const withoutDefinition = createToolDispatch(execute, { policy });
  const noDefinition = await withoutDefinition({ name: 'read_file', arguments: '{}' }, {});
  assert.equal(noDefinition.ok, false);
  assert.match(noDefinition.error, /definition is required/i);

  const dispatch = createToolDispatch(execute, { definition, policy });
  const malformed = await dispatch({ name: 'read_file', arguments: '{not-json' }, {});
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /invalid JSON/i);
  assert.equal(calls, 0);
});
