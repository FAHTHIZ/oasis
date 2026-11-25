import test from 'node:test';
import assert from 'node:assert/strict';
import { toolActivityOutcome } from '../src/tool-activity.mjs';

test('a write stopped by plan mode reads as blocked, not failed', () => {
  const message = 'Plan mode blocks write, command, install, delete, and external tool calls.';
  assert.equal(toolActivityOutcome({ error: message }), 'blocked');
  assert.equal(toolActivityOutcome(JSON.stringify({ error: message })), 'blocked');
  assert.equal(toolActivityOutcome('Error: ' + message), 'blocked');
  assert.equal(toolActivityOutcome({ error: 'ENOENT: no such file' }), 'failed');
});
