import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionMode, attentionSequence, notifyAttention, notifyAfterMs } from '../src/attention.mjs';

const tty = () => { const out = []; return { isTTY: true, write: (s) => out.push(s), out }; };

test('attention mode follows the terminal and stays quiet off-TTY, in CI and when disabled', () => {
  assert.equal(attentionMode({ TERM_PROGRAM: 'iTerm.app' }, tty()), 'osc9');
  assert.equal(attentionMode({ TERM_PROGRAM: 'WezTerm' }, tty()), 'osc9');
  assert.equal(attentionMode({ WT_SESSION: 'x' }, tty()), 'osc9');
  assert.equal(attentionMode({ TERM: 'xterm-kitty' }, tty()), 'osc99');
  assert.equal(attentionMode({ TERM: 'xterm-256color' }, tty()), 'bell');
  assert.equal(attentionMode({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/t' }, tty()), 'bell');
  assert.equal(attentionMode({ CI: 'true' }, tty()), 'off');
  assert.equal(attentionMode({ OASIS_NOTIFY: 'off', TERM_PROGRAM: 'iTerm.app' }, tty()), 'off');
  assert.equal(attentionMode({ TERM_PROGRAM: 'iTerm.app' }, { isTTY: false, write() {} }), 'off');
  assert.equal(attentionMode({ OASIS_NOTIFY: 'osc', TERM: 'xterm' }, tty()), 'osc9');
  assert.equal(attentionMode({ OASIS_NOTIFY: 'bell', CI: '1' }, tty()), 'bell');
});

test('notification text cannot break out of the escape sequence', () => {
  const seq = attentionSequence('osc9', 'Done\x07\x1b]0;evil\x1b\\ · 20s');
  assert.equal(seq, '\x1b]9;Done ]0;evil \\ · 20s\x07');
  assert.equal(attentionSequence('osc99', 'Hi'), '\x1b]99;;Hi\x1b\\');
  assert.equal(attentionSequence('bell', 'x'), '\x07');
  assert.equal(attentionSequence('off', 'x'), '');
});

test('short turns do not notify; long turns do; the threshold is configurable', () => {
  const env = { TERM_PROGRAM: 'iTerm.app' };
  const s1 = tty();
  assert.equal(notifyAttention('Done', { elapsedMs: 3000, env, stream: s1 }), '');
  assert.deepEqual(s1.out, []);
  const s2 = tty();
  notifyAttention('Done · 20s', { elapsedMs: 20000, env, stream: s2 });
  assert.deepEqual(s2.out, ['\x1b]9;Done · 20s\x07']);
  assert.equal(notifyAfterMs({ OASIS_NOTIFY_AFTER_SECONDS: '0' }), 0);
  assert.equal(notifyAfterMs({}), 15000);
  const s3 = tty();
  notifyAttention('Done', { elapsedMs: 1, env: { ...env, OASIS_NOTIFY_AFTER_SECONDS: '0' }, stream: s3 });
  assert.equal(s3.out.length, 1);
});
