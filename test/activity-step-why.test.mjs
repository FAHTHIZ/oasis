import test from 'node:test';
import assert from 'node:assert/strict';
import { stepWhy } from '../app/activity.mjs';

test('a failed step in the Activity panel says why, from JSON or text results', () => {
  assert.equal(stepWhy({ content: '{"error":"Edit 1: old_string and new_string are identical."}' }), 'Edit 1: old_string and new_string are identical.');
  assert.equal(stepWhy({ content: '{"error":"ENOENT: no such file"}\n[note] read it first' }), 'ENOENT: no such file');
  assert.equal(stepWhy({ content: '{"exitCode":1,"stderr":"npm ERR! missing script"}' }), 'npm ERR! missing script');
  assert.equal(stepWhy({ content: '\n  plain failure\nsecond line' }), 'plain failure');
  assert.equal(stepWhy({}), '');
  assert.ok(stepWhy({ content: 'x'.repeat(500) }).length <= 300);
});

test('an Error box that only repeats the why line is recognised', async () => {
  const { repeatsWhy } = await import('../app/activity.mjs');
  assert.equal(repeatsWhy('This step failed: Bad args.', 'Bad args.'), true);
  assert.equal(repeatsWhy('Bad args.', 'Bad args.'), true);
  assert.equal(repeatsWhy('Bad args.\nstack trace line', 'Bad args.'), false);
  assert.equal(repeatsWhy('anything', ''), false);
});
