import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyDecoder } from '../src/line-editor.mjs';

const keys = (raw) => new KeyDecoder().feed(raw);
const names = (raw) => keys(raw).map((key) => key.name);
const strokes = (raw) => keys(raw).map((key) => key.stroke);

test('kitty CSI-u keys: modifiers, keypad Enter, base-layout keys and release events', () => {
  assert.deepEqual(names('\x1b[13;2u\x1b[13;5u\x1b[13;3u'), ['newline', 'newline', 'newline']);
  assert.deepEqual(strokes('\x1b[13;2u\x1b[13;5u'), ['shift+enter', 'ctrl+enter']);
  assert.deepEqual(names('\x1b[57414u'), ['enter']);
  // Cyrillic layout: Ctrl+с with base-layout key c is Ctrl+C.
  assert.deepEqual(names('\x1b[1089::99;5u'), ['ctrlC']);
  // Releases (flag 2, event type 3) are dropped; presses and repeats count.
  assert.deepEqual(keys('\x1b[97u\x1b[97;1:3u'), [{ name: 'char', text: 'a', stroke: 'a' }]);
  assert.deepEqual(keys('\x1b[65;2u'), [{ name: 'char', text: 'A', stroke: 'shift+a' }]);
  assert.deepEqual(names('\x1b[9;2u\x1b[27u'), ['shiftTab', 'escape']);
  assert.deepEqual(strokes('\x1b[107;6u'), ['ctrl+shift+k']);
  assert.deepEqual(keys('\x1b[27;2;13~').map((k) => k.stroke), ['shift+enter']);
});

test('Alt+keys arrive as meta keys, legacy or CSI-u, and do not insert text', () => {
  assert.deepEqual(names('\x1bb\x1bf\x1bd\x1b\x7f'), ['wordLeft', 'wordRight', 'deleteWord', 'killWord']);
  assert.deepEqual(keys('\x1bv'), [{ name: 'meta', text: 'v', stroke: 'meta+v' }]);
  assert.deepEqual(keys('\x1bV'), [{ name: 'meta', text: 'V', stroke: 'meta+shift+v' }]);
  assert.deepEqual(names('\x1b[98;3u\x1b[102;3u'), ['wordLeft', 'wordRight']);
  assert.deepEqual(keys('\x1b[118;3u'), [{ name: 'meta', text: 'v', stroke: 'meta+v' }]);
  assert.deepEqual(names('\x1b[1;3D\x1b[1;5C\x1b[127;3u'), ['wordLeft', 'wordRight', 'killWord']);
});

test('sequences split across reads are joined, not typed as text', () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.feed('ab\x1b['), [{ name: 'char', text: 'ab' }]);
  assert.deepEqual(decoder.feed('1;5'), []);
  assert.deepEqual(decoder.feed('Cz').map((k) => k.name), ['wordRight', 'char']);
});

test('a split Alt+key waits for its second byte when a callback is given', async () => {
  const later = [];
  const decoder = new KeyDecoder({ onKeys: (k) => later.push(...k) });
  assert.deepEqual(decoder.feed('\x1b'), []);
  assert.deepEqual(decoder.feed('b').map((k) => k.name), ['wordLeft']);
  assert.deepEqual(decoder.feed('\x1b'), []);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(later.map((k) => k.name), ['escape']);
  decoder.destroy();
});

test('terminal replies (OSC colour answers) are not typed into the prompt', () => {
  assert.deepEqual(keys('\x1b]11;rgb:0000/0000/0000\x07x'), [{ name: 'char', text: 'x', stroke: 'x' }]);
});

test('pasted CRLF: bracketed and unbracketed paste keep line breaks and do not submit', () => {
  assert.deepEqual(keys('\x1b[200~one\r\ntwo\rthree\x1b[201~'), [{ name: 'paste', text: 'one\ntwo\nthree' }]);
  assert.deepEqual(keys('a\r\nb\r\nc').map((k) => [k.name, k.text]), [['char', 'a'], ['paste', '\nb\nc']]);
  assert.deepEqual(keys('one\rtwo').map((k) => [k.name, k.text]), [['char', 'one'], ['paste', '\ntwo']]);
  // A paste marker split across reads.
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.feed('\x1b[200~x\x1b[20'), []);
  assert.deepEqual(decoder.feed('1~'), [{ name: 'paste', text: 'x' }]);
});

test('emoji, CJK and combining marks come through as one text run', () => {
  assert.deepEqual(keys('日本😀👨‍👩‍👧é'), [{ name: 'char', text: '日本😀👨‍👩‍👧é' }]);
  assert.deepEqual(keys('😀'), [{ name: 'char', text: '😀', stroke: '😀' }]);
});
