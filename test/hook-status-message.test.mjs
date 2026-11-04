import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runHooks } from '../src/hooks.mjs';

const root = os.tmpdir();
const hooks = (hook) => ({ Stop: [{ hooks: [hook] }] });

test('a hook statusMessage is shown at once and cleared when the hook ends', async () => {
  const seen = [];
  await runHooks('Stop', {}, { root, hooks: hooks({ type: 'command', command: 'true', statusMessage: 'Running the test suite' }), onHookStatus: (event) => seen.push(event) });
  assert.deepEqual(seen.map((event) => event.phase + ':' + (event.label || '')), ['start:Running the test suite', 'end:']);
});

test('a slow hook without statusMessage gets a generic line; a fast one shows nothing', async () => {
  const fast = [];
  await runHooks('Stop', {}, { root, hooks: hooks({ type: 'command', command: 'true' }), onHookStatus: (event) => fast.push(event), hookStatusDelayMs: 2000 });
  assert.deepEqual(fast, []);
  const slow = [];
  await runHooks('Stop', {}, { root, hooks: hooks({ type: 'command', command: 'sleep 0.3' }), onHookStatus: (event) => slow.push(event), hookStatusDelayMs: 50 });
  assert.deepEqual(slow.map((event) => event.phase + ':' + (event.label || '')), ['start:Running Stop hook', 'end:']);
});
