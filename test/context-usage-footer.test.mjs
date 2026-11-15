import test from 'node:test';
import assert from 'node:assert/strict';
import { contextUsage, contextTokens, toolSchemaTokens } from '../src/context.mjs';
import { countJsonTokens } from '../src/tokens.mjs';

const tools = Array.from({ length: 12 }, (_, i) => ({ type: 'function', function: { name: 'tool_' + i, description: 'Does thing number ' + i + ' with a long explanation of its arguments.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'A path' } } } } }));

test('without a provider count, context usage includes the tool schemas sent with each request', () => {
  const session = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], toolDefinitions: tools };
  // The footer used contextTokens alone and showed 7% where /context showed 16%.
  const usage = contextUsage(session);
  assert.equal(usage.reported, false);
  assert.equal(usage.tokens, contextTokens(session).tokens + countJsonTokens(tools));
  assert.equal(toolSchemaTokens(tools), countJsonTokens(tools));
  assert.equal(toolSchemaTokens([]), 0);
});

test('a provider-reported count already includes tool schemas and is used as is', () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
  const session = { messages, toolDefinitions: tools, contextAnchor: { length: 2, last: messages[1], inputTokens: 9000 } };
  assert.deepEqual(contextUsage(session), { tokens: 9000, reported: true });
});
