import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable, isStopPhrase, turnDetector, rmsLevel, lastReply } from '../app/core/voice-mode.mjs';

test('replies are read without code, links or markup', () => {
  const text = speakable('## Done\nI fixed `add()` in [cart](http://x.test/a).\n```js\nconst a = 1;\n```\n- **All** tests pass. See https://example.com/run.');
  assert.doesNotMatch(text, /```|##|\*\*|http/);
  assert.match(text, /I fixed add\(\) in cart/);
  assert.match(text, /code omitted/);
});

test('stop phrases end talk mode', () => {
  for (const phrase of ['stop talking', 'Okay, stop listening.', 'goodbye', "That's all", 'end the conversation']) assert.equal(isStopPhrase(phrase), true, phrase);
  assert.equal(isStopPhrase('stop the server on port 3000'), false);
});

test('a spoken turn ends after speech then silence', () => {
  const detector = turnDetector({ start: 0, silenceMs: 1000 });
  assert.equal(detector.push(0.01, 100), 'listening');
  assert.equal(detector.push(0.2, 500), 'listening');
  assert.equal(detector.push(0.01, 900), 'listening');
  assert.equal(detector.push(0.01, 2000), 'done');
  const quiet = turnDetector({ start: 0, noSpeechMs: 3000 });
  assert.equal(quiet.push(0.0, 3500), 'nothing');
});

test('loudness and the last reply of the turn', () => {
  assert.equal(rmsLevel(new Uint8Array([128, 128, 128])), 0);
  assert.ok(rmsLevel(new Uint8Array([0, 255, 0, 255])) > 0.9);
  const display = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old reply' }, { role: 'user', content: 'fix it' }, { role: 'assistant', content: 'Working', tools: [{}] }, { role: 'assistant', content: 'Fixed it.' }, { role: 'assistant', content: '' }];
  assert.equal(lastReply(display), 'Fixed it.');
  assert.equal(lastReply([{ role: 'user', content: 'x' }]), '');
});
