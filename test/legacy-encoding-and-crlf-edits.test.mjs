import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/tools.mjs';
import { executePowerTool } from '../src/power-tools.mjs';
import { decodeText, encodeText } from '../src/text-encoding.mjs';
import { matchLineEndings } from '../src/edit-match.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-legacy-enc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, context: { root, autoApprove: true } };
}

// "café" in Latin-1 / Windows-1252: 0xE9 is not valid UTF-8.
const latin1 = (text) => Buffer.from(text, 'latin1');

test('a file that is not valid UTF-8 is read byte for byte as Latin-1 and written back unchanged', () => {
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x80, 0xff, 0x0a]);
  const decoded = decodeText(bytes);
  assert.equal(decoded.encoding, 'latin1');
  assert.deepEqual(encodeText(decoded.text, decoded.encoding), bytes);
  assert.equal(decodeText(Buffer.from('café\n', 'utf8')).encoding, 'utf8');
});

test('edit_file keeps the accented letters of a Latin-1 file (they used to become U+FFFD)', async (t) => {
  const { root, context } = await workspace(t);
  await writeFile(path.join(root, 'menu.txt'), latin1('café crème\nprice = 1\n'));
  const read = await executeTool('read_file', { path: 'menu.txt' }, context);
  assert.equal(read.content, 'café crème\nprice = 1\n');
  assert.equal(read.encoding, 'latin1');
  await executeTool('edit_file', { path: 'menu.txt', old_string: 'price = 1', new_string: 'price = 2 (déjà vu)' }, context);
  assert.deepEqual(await readFile(path.join(root, 'menu.txt')), latin1('café crème\nprice = 2 (déjà vu)\n'));
});

test('an edit needing a character Latin-1 cannot hold is refused and the file is untouched', async (t) => {
  const { root, context } = await workspace(t);
  const original = latin1('naïve\n');
  await writeFile(path.join(root, 'a.txt'), original);
  await assert.rejects(executeTool('edit_file', { path: 'a.txt', old_string: 'naïve', new_string: 'naïve 🌴' }, context), /not UTF-8.*Latin-1 cannot store/s);
  await assert.rejects(executePowerTool('multi_edit', { path: 'a.txt', edits: [{ old_string: 'naïve', new_string: 'naïve → ok' }] }, context, root), /Latin-1 cannot store/);
  assert.deepEqual(await readFile(path.join(root, 'a.txt')), original);
});

test('write_file over a Latin-1 file keeps it Latin-1', async (t) => {
  const { root, context } = await workspace(t);
  await writeFile(path.join(root, 'a.sql'), latin1("INSERT 'é';\n"));
  await executeTool('write_file', { path: 'a.sql', content: "INSERT 'è';\n" }, context);
  assert.deepEqual(await readFile(path.join(root, 'a.sql')), latin1("INSERT 'è';\n"));
});

test('exact edits in a CRLF file insert CRLF lines, not bare LF', async (t) => {
  const { root, context } = await workspace(t);
  await writeFile(path.join(root, 'win.txt'), 'one\r\ntwo\r\nthree\r\n');
  await executeTool('edit_file', { path: 'win.txt', old_string: 'two', new_string: 'two\nextra' }, context);
  assert.equal(await readFile(path.join(root, 'win.txt'), 'utf8'), 'one\r\ntwo\r\nextra\r\nthree\r\n');
  await executePowerTool('multi_edit', { path: 'win.txt', edits: [{ old_string: 'one', new_string: 'zero\none' }, { old_string: 'three', new_string: 'three\nfour', replace_all: true }] }, context, root);
  assert.equal(await readFile(path.join(root, 'win.txt'), 'utf8'), 'zero\r\none\r\ntwo\r\nextra\r\nthree\r\nfour\r\n');
});

test('matchLineEndings leaves LF and mixed files alone', () => {
  assert.equal(matchLineEndings('a\nb\n', 'x\ny'), 'x\ny');
  assert.equal(matchLineEndings('a\r\nb\n', 'x\ny'), 'x\ny');
  assert.equal(matchLineEndings('a\r\nb\r\n', 'x\r\ny\nz'), 'x\r\ny\r\nz');
  assert.equal(matchLineEndings('single line', 'x\ny'), 'x\ny');
});
