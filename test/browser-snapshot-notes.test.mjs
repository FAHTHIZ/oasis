// The browser snapshot cut page text at 12,000 characters and numbered at most
// 300 elements without saying so; the model assumed it had seen the whole page.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SNAPSHOT_JS } from '../src/browser-tool.mjs';

function fakePage(text, buttons) {
  const elements = Array.from({ length: buttons }, (_, i) => ({
    tagName: 'BUTTON', innerText: 'b' + i, getBoundingClientRect: () => ({ width: 10, height: 10 }),
    getAttribute: () => null, setAttribute() {}, removeAttribute() {}
  }));
  const document = {
    title: 'T', body: { innerText: text }, documentElement: { scrollHeight: 100 },
    querySelectorAll: (sel) => (sel === '[data-oasis-ref]' ? [] : elements)
  };
  return { document, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), location: { href: 'http://x/' }, scrollY: 0, innerHeight: 100 };
}

test('a long page says its text and element list were cut', () => {
  const snap = vm.runInNewContext(SNAPSHOT_JS, fakePage('a'.repeat(30000), 305));
  assert.equal(snap.text.length, 12000);
  assert.match(snap.textNote, /12000 of 30000 characters/);
  assert.equal(snap.elements.length, 300);
  assert.match(snap.elementsNote, /^5 more visible interactive elements/);
});

test('a short page has no notes', () => {
  const snap = vm.runInNewContext(SNAPSHOT_JS, fakePage('hello', 3));
  assert.equal(snap.text, 'hello');
  assert.equal(snap.textNote, undefined);
  assert.equal(snap.elementsNote, undefined);
  assert.equal(snap.elements.length, 3);
});
