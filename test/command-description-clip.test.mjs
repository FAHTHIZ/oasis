import test from 'node:test';
import assert from 'node:assert/strict';
import { clipDescription } from '../src/cli.mjs';

test('slash-menu skill descriptions are shortened at a word, with an ellipsis', () => {
  // Seen in the slash menu: "Skill: Detect the environment ... the smallest set of to".
  const long = 'Detect the environment and install or configure the smallest set of tools required by a task.';
  const clipped = clipDescription(long, 70);
  assert.ok(clipped.length <= 70, clipped);
  assert.match(clipped, /set of…$/);
  assert.equal(clipDescription('Short one.', 70), 'Short one.');
  assert.equal(clipDescription('a\n  b', 70), 'a b');
  assert.equal(clipDescription('x'.repeat(100), 10), 'x'.repeat(9) + '…');
});
