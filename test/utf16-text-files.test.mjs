import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/tools.mjs';
import { executePowerTool } from '../src/power-tools.mjs';
import { decodeText, encodeText, detectTextEncoding } from '../src/text-encoding.mjs';

const le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const be = (text) => { const b = Buffer.from(text, 'utf16le'); for (let i = 0; i < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1], b[i]]; return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); };

test('UTF-16 round-trips through decodeText/encodeText; UTF-8 BOM is untouched', () => {
  for (const [buffer, encoding] of [[le('Grüße 🌴\r\nx'), 'utf16le'], [be('Grüße 🌴\r\nx'), 'utf16be']]) {
    const decoded = decodeText(buffer);
    assert.deepEqual(decoded, { text: 'Grüße 🌴\r\nx', encoding });
    assert.deepEqual(encodeText(decoded.text, encoding), buffer);
  }
  const bom8 = Buffer.from('\ufeffa', 'utf8');
  assert.equal(detectTextEncoding(bom8), 'utf8');
  assert.equal(encodeText(decodeText(bom8).text), '\ufeffa');
});

test('read_file, edit_file, multi_edit and write_file keep a UTF-16 file UTF-16', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-u16-'));
  const file = path.join(root, 'setup.ps1');
  await writeFile(file, le('Write-Host "hello"\r\n$x = 1\r\n'));
  const context = { root, autoApprove: true };
  // Before: "This looks like a binary file and is not supported by read_file."
  const read = await executeTool('read_file', { path: 'setup.ps1' }, context);
  assert.equal(read.encoding, 'utf16le');
  assert.match(read.content, /Write-Host "hello"/);
  await executeTool('edit_file', { path: 'setup.ps1', old_string: '"hello"', new_string: '"bye"' }, context);
  assert.deepEqual(await readFile(file), le('Write-Host "bye"\r\n$x = 1\r\n'));
  await executePowerTool('multi_edit', { path: 'setup.ps1', edits: [{ old_string: '$x = 1', new_string: '$x = 2' }] }, context, root);
  assert.deepEqual(await readFile(file), le('Write-Host "bye"\r\n$x = 2\r\n'));
  await executeTool('read_file', { path: 'setup.ps1' }, context);
  await executeTool('write_file', { path: 'setup.ps1', content: 'Write-Host "new"\r\n' }, context);
  assert.deepEqual(await readFile(file), le('Write-Host "new"\r\n'));
  await executeTool('write_file', { path: 'fresh.txt', content: 'plain' }, context);
  assert.equal(await readFile(path.join(root, 'fresh.txt'), 'utf8'), 'plain');
});

test('a NUL-bearing file without a UTF-16 BOM is still binary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-u16b-'));
  await writeFile(path.join(root, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
  await assert.rejects(() => executeTool('read_file', { path: 'blob.bin' }, { root, autoApprove: true }), /binary/);
});
