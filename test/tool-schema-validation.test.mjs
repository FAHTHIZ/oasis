import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '../src/tool-schema-validation.mjs';

test('valid arguments pass without being coerced or mutated', async () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
    required: ['path'],
    additionalProperties: false
  };
  const args = { path: 'src/index.mjs', limit: 10 };
  const before = structuredClone(args);
  assert.deepEqual(await validateToolArguments(schema, args), { valid: true, skipped: false });
  assert.deepEqual(args, before);
});

test('missing, mistyped and unsupported properties are rejected with bounded details', async () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' } },
    required: ['path'],
    additionalProperties: false
  };
  const missing = await validateToolArguments(schema, {});
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((error) => error.includes('missing required property "path"')));
  const wrongType = await validateToolArguments(schema, { path: 42 });
  assert.equal(wrongType.valid, false);
  assert.ok(wrongType.errors.some((error) => error.includes('must be string')));
  const extra = await validateToolArguments(schema, { path: 'a', extra: true });
  assert.equal(extra.valid, false);
  assert.ok(extra.errors.some((error) => error.includes('unsupported property "extra"')));
});

test('missing schema metadata is non-blocking for provider aliases and external tools', async () => {
  assert.deepEqual(await validateToolArguments(undefined, { arbitrary: true }), { valid: true, skipped: true });
});

test('invalid tool schemas fail closed instead of executing an unvalidated call', async () => {
  const result = await validateToolArguments({ type: 'not-a-json-schema-type' }, {});
  assert.equal(result.valid, false);
  assert.match(result.schemaError, /schema|type/i);
});

test('all built-in and session tool input schemas compile', async () => {
  const [{ TOOL_DEFINITIONS }, { SESSION_TOOL_DEFINITIONS }] = await Promise.all([
    import('../src/tools.mjs'),
    import('../src/session-tools.mjs')
  ]);
  const definitions = [...TOOL_DEFINITIONS, ...SESSION_TOOL_DEFINITIONS];
  const failures = [];
  for (const tool of definitions) {
    const fn = tool && tool.function;
    if (!fn || !fn.parameters) continue;
    const result = await validateToolArguments(fn.parameters, {});
    if (result.schemaError) failures.push(fn.name + ': ' + result.schemaError);
  }
  assert.deepEqual(failures, [], 'Every advertised built-in input schema must be compilable');
});

test('an invalid write_file call is rejected before a workspace side effect', async (t) => {
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { mkdtemp, rm, access } = await import('node:fs/promises');
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-tool-schema-'));
  const target = path.join(root, 'must-not-exist.txt');
  const { config } = await scriptedModel(t, [
    { content: null, tool_calls: [{
      id: 'invalid-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: 'must-not-exist.txt' }) }
    }] },
    (payload) => ({
      content: JSON.stringify(payload.messages).includes('Invalid arguments for write_file')
        ? 'SCHEMA_VALIDATION_BLOCKED'
        : 'SCHEMA_VALIDATION_MISSING'
    })
  ]);
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  t.after(async () => { await closeSession(session); await rm(root, { recursive: true, force: true }); });
  const result = await runAgentTurn(session, 'Create the file.', {});
  assert.match(String(result.text || result.finalText || JSON.stringify(result)), /SCHEMA_VALIDATION_BLOCKED/);
  await assert.rejects(access(target), { code: 'ENOENT' });
});
