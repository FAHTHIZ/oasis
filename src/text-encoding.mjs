// Text files that are not UTF-8. Windows tools still write UTF-16 with a byte
// order mark (PowerShell 5 scripts, .reg exports, some .rc/.sln/.vcxproj
// files); its NUL bytes made read_file and edit_file call them binary. Files
// with a UTF-16 BOM are decoded here and written back in the same encoding, as
// Claude Code does. Everything else stays UTF-8 (a UTF-8 BOM is kept as the
// U+FEFF character, so it round-trips unchanged).

import { readFile } from 'node:fs/promises';

/** 'utf16le', 'utf16be' or 'utf8' from the first bytes of a buffer. */
export function detectTextEncoding(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf16be';
  return 'utf8';
}

function swapBytes(buffer) {
  const out = Buffer.from(buffer);
  for (let i = 0; i + 1 < out.length; i += 2) { const a = out[i]; out[i] = out[i + 1]; out[i + 1] = a; }
  return out;
}

/** Decode a buffer; UTF-16 loses its BOM, which encodeText adds back. */
export function decodeText(buffer) {
  const encoding = detectTextEncoding(buffer);
  if (encoding === 'utf16le') return { text: buffer.subarray(2).toString('utf16le'), encoding };
  if (encoding === 'utf16be') return { text: swapBytes(buffer.subarray(2)).toString('utf16le'), encoding };
  return { text: buffer.toString('utf8'), encoding };
}

/** Encode text for writing: a Buffer with BOM for UTF-16, the string itself for UTF-8. */
export function encodeText(text, encoding = 'utf8') {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), swapBytes(Buffer.from(text, 'utf16le'))]);
  return text;
}

/** Read a file as text with its encoding. */
export async function readTextFile(file) {
  return decodeText(await readFile(file));
}
