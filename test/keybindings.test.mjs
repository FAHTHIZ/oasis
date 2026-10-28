import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeStroke, normalizeChord, loadKeybindings, resolveBinding, ensureKeybindingsFile, describeKeybindings } from '../src/keybindings.mjs';
import { KeyDecoder, readInput, stash } from '../src/line-editor.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

function sandbox(claude, oasis) {
  const root = mkdtempSync(path.join(tmpdir(), 'oasis-kb-'));
  const env = { HOME: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), OASIS_CONFIG_DIR: path.join(root, 'oasis'), OASIS_HOME: path.join(root, 'oasis') };
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  mkdirSync(env.OASIS_CONFIG_DIR, { recursive: true });
  if (claude) writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'keybindings.json'), JSON.stringify(claude));
  if (oasis) writeFileSync(path.join(env.OASIS_CONFIG_DIR, 'keybindings.json'), JSON.stringify(oasis));
  return { root, env };
}

function tty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 80;
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  return { input, output, rendered: () => rendered };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test('normalizes keystrokes and chords', () => {
  assert.equal(normalizeStroke('Ctrl+Shift+K'), 'ctrl+shift+k');
  assert.equal(normalizeStroke('alt+p'), 'meta+p');
  assert.equal(normalizeStroke('opt+Enter'), 'meta+enter');
  assert.equal(normalizeStroke('Esc'), 'escape');
  assert.equal(normalizeStroke('K'), 'shift+k');
  assert.equal(normalizeChord('ctrl+x   ctrl+E'), 'ctrl+x ctrl+e');
});

test('loads ~/.claude then oasis keybindings, oasis wins, null unbinds, reserved warns', () => {
  const { env } = sandbox(
    { bindings: [{ context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor', 'ctrl+y': 'command:compact' } }] },
    { bindings: [{ context: 'Chat', bindings: { 'ctrl+y': 'command:cost', 'ctrl+s': null, 'ctrl+c': 'chat:submit' } }, { context: 'Nope', bindings: {} }] }
  );
  const kb = loadKeybindings(env);
  assert.equal(kb.contexts.Chat.get('ctrl+e'), 'chat:externalEditor');
  assert.equal(kb.contexts.Chat.get('ctrl+y'), 'command:cost');
  assert.deepEqual(resolveBinding(kb, 'Chat', 'ctrl+s'), { unbound: true });
  assert.equal(kb.contexts.Global.get('ctrl+c'), 'app:interrupt');
  assert.ok(kb.warnings.some((w) => /reserved/.test(w)));
  assert.ok(kb.warnings.some((w) => /unknown context/.test(w)));
  assert.equal(kb.files.length, 2);
  const described = describeKeybindings(env);
  assert.ok(described.lines.some((line) => /ctrl\+y\s+command:cost/.test(line)));
});

test('resolves chords as prefixes and falls back to Global', () => {
  const { env } = sandbox(null, { bindings: [{ context: 'Chat', bindings: { 'ctrl+k ctrl+s': 'chat:stash' } }] });
  const kb = loadKeybindings(env);
  assert.deepEqual(resolveBinding(kb, 'Chat', 'ctrl+k'), { prefix: true });
  assert.deepEqual(resolveBinding(kb, 'Chat', 'ctrl+k ctrl+s'), { action: 'chat:stash' });
  assert.deepEqual(resolveBinding(kb, 'Autocomplete', 'ctrl+t'), { action: 'app:toggleTodos' });
  assert.equal(resolveBinding(kb, 'Chat', 'ctrl+q'), null);
});

test('decoder reports keystroke names', () => {
  const strokes = (data) => new KeyDecoder().feed(data).map((key) => key.stroke);
  assert.deepEqual(strokes('\x07\r\t\x7f\n\x1f'), ['ctrl+g', 'enter', 'tab', 'backspace', 'ctrl+j', 'ctrl+_']);
  assert.deepEqual(strokes('\x1b[1;5A\x1b[Z\x1b[13;2u\x1bp'), ['ctrl+up', 'shift+tab', 'shift+enter', 'meta+p']);
  assert.deepEqual(strokes('K'), ['shift+k']);
  assert.deepEqual(strokes(' '), ['space']);
  const kitty = new KeyDecoder().feed('\x1b[97;5u');
  assert.equal(kitty[0].stroke, 'ctrl+a');
  assert.equal(kitty[0].name, 'home');
});

test('readInput runs a custom command binding and a remapped key', async () => {
  const { env } = sandbox(null, { bindings: [{ context: 'Chat', bindings: { 'ctrl+y': 'command:compact', 'ctrl+k ctrl+u': 'chat:submit' } }] });
  let t = tty();
  let done = readInput({ input: t.input, output: t.output, color: false, env });
  t.input.write('draft');
  t.input.write('\x19');
  assert.deepEqual(await done, { type: 'submit', text: '/compact' });

  t = tty();
  done = readInput({ input: t.input, output: t.output, color: false, env });
  t.input.write('hi');
  t.input.write('\x0b');
  await tick();
  t.input.write('\x15');
  const result = await done;
  assert.equal(result.type, 'submit');
  assert.equal(result.text, 'hi');
});

test('Ctrl+S stashes the prompt and restores it after the next message', async () => {
  const { env } = sandbox();
  stash.text = ''; stash.pendingRestore = false;
  let t = tty();
  let done = readInput({ input: t.input, output: t.output, color: false, env });
  t.input.write('long draft');
  t.input.write('\x13');
  await tick();
  t.input.write('quick question\r');
  assert.equal((await done).text, 'quick question');
  t = tty();
  done = readInput({ input: t.input, output: t.output, color: false, env });
  t.input.write('\r');
  assert.equal((await done).text, 'long draft');
});

test('Ctrl+G opens the prompt in $EDITOR', { skip: process.platform === 'win32' }, async () => {
  const { root, env } = sandbox();
  const script = path.join(root, 'fake-editor.sh');
  writeFileSync(script, '#!/bin/sh\nprintf "edited in editor\\n" > "$1"\n');
  chmodSync(script, 0o755);
  env.EDITOR = script;
  const t = tty();
  const done = readInput({ input: t.input, output: t.output, color: false, env });
  t.input.write('original');
  t.input.write('\x07');
  await tick();
  t.input.write('\r');
  assert.equal((await done).text, 'edited in editor');
});

test('/keybindings init creates the file and /keybindings lists custom bindings', async () => {
  const { env } = sandbox();
  const created = await runBuiltinCommand('keybindings', 'init', { root: process.cwd(), env });
  assert.match(created.output, /Created/);
  const file = path.join(env.OASIS_CONFIG_DIR, 'keybindings.json');
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /chat:externalEditor/);
  const listed = await runBuiltinCommand('keybindings', '', { root: process.cwd(), env });
  assert.match(listed.output, /Custom keybindings:/);
  assert.match(listed.output, /ctrl\+e/);
  const again = await ensureKeybindingsFile(env);
  assert.equal(again.created, false);
});
