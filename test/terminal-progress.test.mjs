import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalProgressEnabled, terminalProgressSequence, createTerminalProgress } from '../src/terminal-progress.mjs';

const tty = () => { const out = []; return { isTTY: true, out, write(chunk) { out.push(chunk); } }; };

test('progress is on only for terminals known to implement OSC 9;4', () => {
  const s = tty();
  assert.equal(terminalProgressEnabled({ WT_SESSION: 'x' }, s), true);
  assert.equal(terminalProgressEnabled({ TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.2.3' }, s), true);
  assert.equal(terminalProgressEnabled({ TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.1.9' }, s), false);
  assert.equal(terminalProgressEnabled({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6' }, s), true);
  assert.equal(terminalProgressEnabled({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.14' }, s), false, 'older iTerm2 would show a notification');
  assert.equal(terminalProgressEnabled({ TERM_PROGRAM: 'Apple_Terminal' }, s), false);
  assert.equal(terminalProgressEnabled({ WT_SESSION: 'x', TMUX: '/tmp/t' }, s), false);
  assert.equal(terminalProgressEnabled({ WT_SESSION: 'x', CI: '1' }, s), false);
  assert.equal(terminalProgressEnabled({ WT_SESSION: 'x' }, { isTTY: false }), false);
  assert.equal(terminalProgressEnabled({ WT_SESSION: 'x', OASIS_TERMINAL_PROGRESS: 'off' }, s), false);
  assert.equal(terminalProgressEnabled({ OASIS_TERMINAL_PROGRESS: 'on' }, s), true);
});

test('sequences follow the ConEmu OSC 9;4 states', () => {
  assert.equal(terminalProgressSequence('busy'), '\x1b]9;4;3;\x07');
  assert.equal(terminalProgressSequence('paused'), '\x1b]9;4;4;\x07');
  assert.equal(terminalProgressSequence('error'), '\x1b]9;4;2;100\x07');
  assert.equal(terminalProgressSequence('clear'), '\x1b]9;4;0;\x07');
  assert.equal(terminalProgressSequence('bogus'), '');
});

test('the reporter writes only on state changes and stays silent when unsupported', () => {
  const s = tty();
  const progress = createTerminalProgress({ env: { WT_SESSION: '1' }, stream: s });
  progress.set('busy'); progress.set('busy'); progress.set('paused'); progress.set('busy'); progress.set('clear');
  assert.deepEqual(s.out, ['\x1b]9;4;3;\x07', '\x1b]9;4;4;\x07', '\x1b]9;4;3;\x07', '\x1b]9;4;0;\x07']);
  const quiet = tty();
  const off = createTerminalProgress({ env: {}, stream: quiet });
  off.set('busy'); off.set('clear');
  assert.deepEqual(quiet.out, []);
  assert.equal(off.enabled, false);
});
