import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTool, runTool } from '../src/tool-kernel.mjs';

const policy = { decide: () => ({ decision: 'allow' }) };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('time spent waiting for a person does not count toward the tool timeout', async () => {
  const tool = defineTool({
    name: 'asks_first', capabilities: ['read'], risk: 'low', timeoutMs: 150, inputSchema: { type: 'object' },
    run: async (_input, runtime) => {
      const approved = await runtime.waitForUser(async () => { await delay(400); return true; });
      await delay(50);
      return { approved };
    }
  });
  const result = await runTool(tool, {}, { policy });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.output, { approved: true });
});

test('the tool timeout still applies to work before and after the wait', async () => {
  const tool = defineTool({
    name: 'slow_after_ask', capabilities: ['read'], risk: 'low', timeoutMs: 150, inputSchema: { type: 'object' },
    run: async (_input, runtime) => {
      await delay(100);
      await runtime.waitForUser(() => delay(200));
      await delay(100);
      return { done: true };
    }
  });
  const result = await runTool(tool, {}, { policy });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('cancellation still stops a tool that is waiting for a person', async () => {
  const controller = new AbortController();
  const tool = defineTool({
    name: 'waits_forever', capabilities: ['read'], risk: 'low', timeoutMs: 100, inputSchema: { type: 'object' },
    run: async (_input, runtime) => runtime.waitForUser(() => new Promise(() => {}))
  });
  setTimeout(() => controller.abort(new Error('stop')), 250);
  const result = await runTool(tool, {}, { policy, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
});
