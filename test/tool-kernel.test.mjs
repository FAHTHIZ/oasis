import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, defineTool, runTool, redactAuditValue } from '../src/tool-kernel.mjs';

const readTool = defineTool({ name: 'read_file', title: 'Read file', description: 'Read a file from the workspace.', capabilities: ['read'], risk: 'low', inputSchema: { required: ['path'] }, run: async (input) => ({ path: input.path, content: 'ok' }) });
const writeTool = defineTool({ name: 'write_file', title: 'Write file', description: 'Write a file in the workspace.', capabilities: ['write'], risk: 'high', requiresApproval: true, inputSchema: { required: ['path'] }, rollback: { supported: true, kind: 'file-snapshot' }, run: async (input) => ({ path: input.path, written: true }) });
const shellTool = defineTool({ name: 'run_command', title: 'Run command', description: 'Run a shell command.', capabilities: ['execute'], risk: 'critical', inputSchema: { required: ['command'] }, run: async (input) => ({ command: input.command, output: 'done' }) });

test('tool definitions validate capabilities and defaults', () => {
  assert.deepEqual(readTool.capabilities, ['read']);
  assert.equal(readTool.risk, 'low');
  assert.equal(writeTool.requiresApproval, true);
  assert.equal(writeTool.rollback.kind, 'file-snapshot');
  assert.throws(() => defineTool({ name: 'bad name', title: 'x', description: 'x', capabilities: ['read'], run: async () => {} }));
});

test('tool definitions reject unknown capabilities and risk levels', () => {
  assert.throws(() => defineTool({ name: 'bad_capability', capabilities: ['filesystem'], run: async () => null }), /Unknown tool capability/);
  assert.throws(() => defineTool({ name: 'bad_risk', capabilities: ['read'], risk: 'extreme', run: async () => null }), /Unknown tool risk level/);
});
test('registry prevents duplicate tools and supports capability lookup', () => {
  const registry = createToolRegistry([readTool, writeTool, shellTool]);
  assert.equal(registry.has('read_file'), true);
  assert.equal(registry.get('missing'), null);
  assert.deepEqual(registry.byCapability('write').map((tool) => tool.name), ['write_file']);
  assert.throws(() => createToolRegistry([readTool, readTool]), /Duplicate tool name/);
});

test('policy deny blocks execution and records an audit event', async () => {
  const policy = { decide: () => ({ decision: 'deny', reason: 'not allowed' }) };
  const result = await runTool(readTool, { path: 'README.md' }, { policy });
  assert.equal(result.ok, false);
  assert.equal(result.decision.decision, 'deny');
  assert.equal(result.error, 'not allowed');
  assert.equal(result.audit.tool, 'read_file');
});

test('input validation applies JSON Schema types and additional-property rules', async () => {
  const typed = defineTool({
    name: 'typed_read',
    capabilities: ['read'],
    risk: 'low',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    run: async (input) => input.path
  });
  const policy = { decide: () => ({ decision: 'allow' }) };
  const wrongType = await runTool(typed, { path: 42 }, { policy });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.error, /expected string/);
  const extraProperty = await runTool(typed, { path: 'README.md', unexpected: true }, { policy });
  assert.equal(extraProperty.ok, false);
  assert.match(extraProperty.error, /unexpected property/);
});
test('approval-required tools become pending approvals even if policy allows them', async () => {
  const policy = { decide: () => ({ decision: 'allow' }) };
  const result = await runTool(writeTool, { path: 'src/a.js' }, { policy });
  assert.equal(result.ok, false);
  assert.equal(result.pendingApproval, true);
  assert.equal(result.decision.decision, 'ask');
});

test('allowed tools execute and redact secrets in audit records', async () => {
  const policy = { decide: () => ({ decision: 'allow' }) };
  const result = await runTool(shellTool, { command: 'curl -H "Authorization: Bearer sk-secret-token-123456"' }, { policy });
  assert.equal(result.ok, true);
  assert.equal(result.output.output, 'done');
  assert.match(result.audit.input.command, /\[redacted\]/);
  assert.doesNotMatch(result.audit.input.command, /sk-secret-token-123456/);
});

test('timeout abort still reaches handlers when the caller supplies a signal', async () => {
  const slow = defineTool({
    name: 'slow_read', capabilities: ['read'], risk: 'low', timeoutMs: 25, inputSchema: { type: 'object' },
    run: async (_input, { signal }) => await new Promise((resolve) => signal.addEventListener('abort', () => resolve('handler observed abort'), { once: true }))
  });
  const caller = new AbortController();
  const result = await runTool(slow, {}, { policy: { decide: () => ({ decision: 'allow' }) }, signal: caller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /Tool timed out/);
});

test('a tool does not start when the caller signal is already aborted', async () => {
  let invocations = 0;
  const guarded = defineTool({
    name: 'pre_cancelled_read',
    capabilities: ['read'],
    risk: 'low',
    inputSchema: { type: 'object' },
    run: async () => { invocations++; return 'should not run'; }
  });
  const caller = new AbortController();
  caller.abort(new Error('cancelled before dispatch'));
  const result = await runTool(guarded, {}, {
    policy: { decide: () => ({ decision: 'allow' }) },
    signal: caller.signal
  });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(invocations, 0);
});
test('caller cancellation is forwarded to the tool handler', async () => {
  const slow = defineTool({
    name: 'cancellable_read', capabilities: ['read'], risk: 'low', timeoutMs: 2000, inputSchema: { type: 'object' },
    run: async (_input, { signal }) => await new Promise((resolve) => signal.addEventListener('abort', () => resolve('handler observed abort'), { once: true }))
  });
  const caller = new AbortController();
  const pending = runTool(slow, {}, { policy: { decide: () => ({ decision: 'allow' }) }, signal: caller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  caller.abort(new Error('caller cancelled task'));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, undefined);
  assert.match(result.error, /caller cancelled task/);
});
test('missing required input fails without invoking the tool', async () => {
  const policy = { decide: () => ({ decision: 'allow' }) };
  const result = await runTool(readTool, {}, { policy });
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing required input/);
});

test('tool failure audit records redact secrets from error messages', async () => {
  const failing = defineTool({
    name: 'failing_read',
    capabilities: ['read'],
    risk: 'low',
    inputSchema: { type: 'object' },
    run: async () => { throw new Error('Request failed: Authorization: Bearer sk-secret-token-123456'); }
  });
  const result = await runTool(failing, {}, { policy: { decide: () => ({ decision: 'allow' }) } });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.audit.error, /sk-secret-token-123456/);
  assert.match(result.audit.error, /\[redacted\]/);
});

test('audit redaction masks credential-named CLI flags but preserves ordinary arguments', () => {
  const value = redactAuditValue({
    command: 'deploy --token plainSecretValue --region ap-southeast-1 --password="p@ss word"',
    args: ['--api-key', 'anotherPlainSecret', '--limit', '10', '--access-token=embeddedSecret']
  });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /plainSecretValue|anotherPlainSecret|embeddedSecret|p@ss word/);
  assert.match(serialized, /--region ap-southeast-1/);
  assert.match(serialized, /--limit/);
  assert.match(serialized, /10/);
  assert.match(serialized, /\[redacted\]/);
});

test('tool kernel rejects non-object arguments without invoking the tool', async () => {
  let invocations = 0;
  const tool = defineTool({
    name: 'object_only',
    capabilities: ['read'],
    risk: 'low',
    inputSchema: { type: 'object' },
    run: async () => { invocations++; return 'ran'; }
  });
  const policy = { decide: () => ({ decision: 'allow' }) };
  for (const input of [null, 'not-json-object', [], 42]) {
    const result = await runTool(tool, input, { policy });
    assert.equal(result.ok, false);
    assert.match(result.error, /arguments must be a JSON object/i);
  }
  assert.equal(invocations, 0);
});

test('tool definitions clamp invalid and excessive timeouts', () => {
  const base = { name: 'bounded_timeout', capabilities: ['read'], run: async () => 'ok' };
  assert.equal(defineTool({ ...base, timeoutMs: -1 }).timeoutMs, 120000);
  assert.equal(defineTool({ ...base, timeoutMs: Number.NaN }).timeoutMs, 120000);
  assert.equal(defineTool({ ...base, timeoutMs: 5_000_000 }).timeoutMs, 900000);
  assert.equal(defineTool({ ...base, timeoutMs: 25 }).timeoutMs, 25);
});

test('policy reasons are redacted before they are returned to callers', async () => {
  const result = await runTool(readTool, { path: 'README.md' }, {
    policy: { decide: () => ({ decision: 'deny', reason: 'Refused: --token plainPolicyCredentialValue' }) }
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /plainPolicyCredentialValue/);
  assert.match(result.error, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(result.audit), /plainPolicyCredentialValue/);
});
