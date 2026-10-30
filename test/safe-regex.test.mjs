import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedRegexMatcher } from '../src/safe-regex.mjs';

test('bounded regex worker preserves ordinary regex matching', async () => {
  const matcher = createBoundedRegexMatcher('^tick\\s+[0-9]+$', 'i');
  try {
    await matcher.ready;
    assert.equal(await matcher.test('TICK 42'), true);
    assert.equal(await matcher.test('not a tick'), false);
  } finally {
    await matcher.close();
  }
});

test('bounded regex worker terminates pathological matches without blocking the main event loop', async () => {
  const matcher = createBoundedRegexMatcher('^(a+)+$', '', { timeoutMs: 50 });
  try {
    await matcher.ready;
    let timerFired = false;
    const tick = new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 0));
    await assert.rejects(matcher.test('a'.repeat(100000) + '!'), /time limit|terminated/);
    await tick;
    assert.equal(timerFired, true);
  } finally {
    await matcher.close();
  }
});

test('bounded regex worker rejects invalid expressions', async () => {
  const matcher = createBoundedRegexMatcher('(');
  try {
    await assert.rejects(matcher.ready, /Invalid regular expression/);
  } finally {
    await matcher.close();
  }
});
