import test from 'node:test';
import assert from 'node:assert/strict';
import { FEN, FEN_BLINK, FEN_PALETTE, fenLines } from '../src/mascot.mjs';
import { bannerFrame, bannerLayout } from '../src/terminal-ui.mjs';

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

test('Fen is a rectangular sprite drawn only with palette colors', () => {
  for (const sprite of [FEN, FEN_BLINK]) {
    assert.ok(sprite.every((row) => row.length === FEN[0].length));
    for (const key of sprite.join('').replace(/\./g, '')) assert.ok(FEN_PALETTE[key], key);
  }
  assert.ok(FEN.some((row) => row.includes('N')), 'open eyes');
  assert.notDeepEqual(FEN_BLINK, FEN);
});

test('fenLines packs two pixel rows into each terminal line', () => {
  const plain = fenLines({ color: false });
  assert.equal(plain.length, Math.ceil(FEN.length / 2));
  assert.ok(plain.every((line) => line.length === FEN[0].length));
  assert.ok(fenLines({ color: true })[0].includes('\x1b[38;2;'));
});

test('the banner puts Fen beside the wordmark and drops pieces in narrow terminals', () => {
  const full = bannerFrame({ color: false, layout: 'full' }).map(strip);
  assert.equal(full.length, fenLines({ color: false }).length);
  assert.match(full.at(-1), /██████/);
  assert.equal(bannerLayout(120, {}), 'full');
  assert.equal(bannerLayout(120, { OASIS_NO_MASCOT: '1' }), 'logo');
  assert.equal(bannerLayout(45, {}), 'logo');
  assert.equal(bannerLayout(20, {}), 'fen');
  assert.equal(bannerLayout(10, {}), 'none');
});
