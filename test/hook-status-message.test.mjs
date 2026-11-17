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

test('a hook that blocks or fails reports how it ended, with the reason', async () => {
  const blocked = [];
  await runHooks('Stop', {}, { root, hooks: hooks({ type: 'command', command: 'echo "tests are red" >&2; exit 2' }), onHookStatus: (event) => blocked.push(event), hookStatusDelayMs: 5000 });
  const last = blocked.at(-1);
  assert.equal(last.phase, 'result');
  assert.equal(last.outcome, 'blocked');
  assert.match(last.reason, /tests are red/);
  const failed = [];
  await runHooks('Stop', {}, { root, hooks: hooks({ type: 'command', command: 'echo boom >&2; exit 1' }), onHookStatus: (event) => failed.push(event), hookStatusDelayMs: 5000 });
  assert.equal(failed.at(-1).outcome, 'failed');
  assert.match(failed.at(-1).reason, /Stop hook failed \(exit 1\): boom/);
  const fine = [];
  await runHooks('Stop', {}, { root, hooks: hooks({ type: 'command', command: 'true' }), onHookStatus: (event) => fine.push(event), hookStatusDelayMs: 5000 });
  assert.deepEqual(fine, []);
});
