import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineImageProtocol, inlineImageSequence, writeInlineImages } from '../src/inline-image.mjs';

const tty = { isTTY: true, columns: 100 };
const png = { mediaType: 'image/png', data: Buffer.alloc(9000, 7).toString('base64'), width: 800, height: 400 };

test('inlineImageProtocol detects capable terminals and stays off elsewhere', () => {
  assert.equal(inlineImageProtocol({ TERM: 'xterm-kitty' }, tty), 'kitty');
  assert.equal(inlineImageProtocol({ TERM_PROGRAM: 'ghostty' }, tty), 'kitty');
  assert.equal(inlineImageProtocol({ TERM_PROGRAM: 'iTerm.app' }, tty), 'iterm');
  assert.equal(inlineImageProtocol({ TERM_PROGRAM: 'WezTerm' }, tty), 'iterm');
  assert.equal(inlineImageProtocol({ TERM: 'xterm-256color' }, tty), null);
  assert.equal(inlineImageProtocol({ TERM: 'xterm-kitty' }, { isTTY: false }), null, 'never into a pipe');
  assert.equal(inlineImageProtocol({ TERM: 'xterm-kitty', TMUX: '/tmp/tmux-1' }, tty), null, 'tmux swallows image escapes');
  assert.equal(inlineImageProtocol({ TERM_PROGRAM: 'iTerm.app', CI: 'true' }, tty), null);
  assert.equal(inlineImageProtocol({ TERM: 'xterm-kitty', OASIS_INLINE_IMAGES: '0' }, tty), null);
  assert.equal(inlineImageProtocol({ TERM: 'dumb', OASIS_INLINE_IMAGES: 'iterm' }, tty), 'iterm');
});

test('iTerm2 sequence carries the size, width in cells and the data', () => {
  const seq = inlineImageSequence(png, 'iterm', { columns: 100 });
  assert.match(seq, /^\x1b\]1337;File=inline=1;size=9000;width=64;height=16;preserveAspectRatio=1:/, 'a wide image is capped at 16 rows, keeping its shape');
  assert.ok(seq.endsWith(png.data + '\x07'));
});

test('Kitty sequence is chunked PNG with continuation flags; non-PNG is skipped', () => {
  const seq = inlineImageSequence(png, 'kitty', { columns: 100 });
  const parts = seq.split('\x1b\\').filter(Boolean);
  assert.equal(parts.length, Math.ceil(png.data.length / 4096));
  assert.match(parts[0], /^\x1b_Ga=T,f=100,q=2,c=\d+,r=\d+,m=1;/);
  assert.match(parts.at(-1), /^\x1b_Gm=0;/);
  assert.equal(inlineImageSequence({ ...png, mediaType: 'image/jpeg' }, 'kitty'), '');
  assert.equal(inlineImageSequence({ mediaType: 'image/png', data: '<script>' }, 'iterm'), '', 'rejects non-base64 data');
  assert.equal(inlineImageSequence(png, null), '');
});

test('writeInlineImages writes nothing on plain terminals and never throws', async () => {
  let written = '';
  const stream = { isTTY: true, columns: 80, write: (chunk) => { written += chunk; return true; } };
  assert.equal(await writeInlineImages([png], { stream, env: { TERM: 'xterm' } }), false);
  assert.equal(written, '');
  assert.equal(await writeInlineImages([png], { stream, env: { TERM_PROGRAM: 'iTerm.app' } }), true);
  assert.ok(written.includes('\x1b]1337;File='));
  assert.equal(await writeInlineImages(null, { stream, env: { TERM_PROGRAM: 'iTerm.app' } }), false);
});
