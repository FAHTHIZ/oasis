import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAppToolArguments } from '../app/core/tool-validation.mjs';

const schema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    n: { type: 'integer' },
    mode: { enum: ['a', 'b'] },
    list: { type: 'array', items: { type: 'string' } },
    x: { anyOf: [{ type: 'string' }, { type: 'number' }] }
  },
  required: ['path'],
  additionalProperties: false
};

test('valid arguments pass and a missing schema is skipped', async () => {
  assert.deepEqual(await validateAppToolArguments(schema, { path: 'a', n: 2, mode: 'b', list: ['x'], x: 3 }), { valid: true, skipped: false });
  assert.deepEqual(await validateAppToolArguments(undefined, {}), { valid: true, skipped: true });
});

test('each problem is reported once at its own path, without wrapper noise', async () => {
  const result = await validateAppToolArguments(schema, { n: 1.5, mode: 'c', list: ['a', 2], extra: 1, x: true });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    '/ does not have required property "path"',
    '/n type "number" is invalid. Expected "integer"',
    '/mode does not match any of ["a","b"]',
    '/list/1 type "number" is invalid. Expected "string"',
    '/x does not match any subschemas',
    '/ contains unsupported property "extra"'
  ]);
});

test('keywords the old hand-written subset ignored are enforced: $ref, const, oneOf', async () => {
  const refSchema = { type: 'object', $defs: { name: { type: 'string', const: 'ok' } }, properties: { a: { $ref: '#/$defs/name' }, b: { oneOf: [{ type: 'integer' }, { type: 'number' }] } }, $schema: 'https://json-schema.org/draft/2020-12/schema' };
  assert.equal((await validateAppToolArguments(refSchema, { a: 'ok', b: 1.5 })).valid, true);
  const bad = await validateAppToolArguments(refSchema, { a: 'no', b: 2 });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.startsWith('/a ')), bad.errors.join('; '));
  assert.ok(bad.errors.some((e) => e.startsWith('/b ')), 'an integer matches both oneOf branches');
});
