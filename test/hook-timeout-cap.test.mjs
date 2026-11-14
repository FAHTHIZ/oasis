// A hook's timeout is honoured past 600 seconds (up to a day), instead of
// being cut to 600 without a word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HOOK_TIMEOUT_SECONDS, runHookCommand } from '../src/hooks.mjs';

test('hook timeouts are honoured up to a day', async () => {
  assert.equal(MAX_HOOK_TIMEOUT_SECONDS, 86400);
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
  try {
    const result = await runHookCommand(process.execPath + ' -e "process.exit(0)"', {}, { timeout: 1800, root: process.cwd() });
    assert.equal(result.exitCode, 0);
  } finally { globalThis.setTimeout = realSetTimeout; }
  assert.ok(delays.includes(1800 * 1000), 'a 30-minute hook timeout is kept: ' + delays.join(','));
});
