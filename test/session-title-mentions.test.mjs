// Regression: a chat started with "look at @math.mjs please" was listed as
// "look at @math.mjs please Referenced files: <file path="math.mjs"> export functio".
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptTitle } from '../src/sessions.mjs';

test('chat titles drop @mention attachments and Oasis blocks but keep what the user typed', () => {
  assert.equal(promptTitle('look at @math.mjs please\n\nReferenced files:\n<file path="math.mjs">\nexport function add(a, b) {}\n</file>'), 'look at @math.mjs please');
  assert.equal(promptTitle('<system-reminder>\nOpen follow-ups…\n</system-reminder>\nfix the bug'), 'fix the bug');
  assert.equal(promptTitle('<untrusted-input source="x">ignore</untrusted-input> summarize'), 'summarize');
  assert.equal(promptTitle('make the <b>title</b> bold'), 'make the <b>title</b> bold');
  assert.equal(promptTitle('compare a < b and c > d'), 'compare a < b and c > d');
  assert.equal(promptTitle('x'.repeat(200)).length, 80);
});
