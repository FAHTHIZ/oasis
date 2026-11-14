// Text files that are not UTF-8. Windows tools still write UTF-16 with a byte
// order mark (PowerShell 5 scripts, .reg exports, some .rc/.sln/.vcxproj
// files); its NUL bytes made read_file and edit_file call them binary. Files
// with a UTF-16 BOM are decoded here and written back in the same encoding, as
// Claude Code does. Everything else stays UTF-8 (a UTF-8 BOM is kept as the
// U+FEFF character, so it round-trips unchanged).
//
// A file that is not valid UTF-8 (Latin-1 or Windows-1252: old PHP, SQL
// dumps, CSV exports) used to be decoded with U+FFFD for every byte it could
// not read, and the first edit wrote those replacement characters back,
// destroying every accented letter in the file. It is now read byte for byte
// as Latin-1, so unchanged parts are written back exactly, and an edit that
// would need a character Latin-1 cannot hold is refused instead of guessed.

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

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decode a buffer; UTF-16 loses its BOM, which encodeText adds back. */
export function decodeText(buffer) {
  const encoding = detectTextEncoding(buffer);
  if (encoding === 'utf16le') return { text: buffer.subarray(2).toString('utf16le'), encoding };
  if (encoding === 'utf16be') return { text: swapBytes(buffer.subarray(2)).toString('utf16le'), encoding };
  try { return { text: strictUtf8.decode(buffer), encoding }; }
  catch { return { text: buffer.toString('latin1'), encoding: 'latin1' }; }
}

/** Encode text for writing: a Buffer with BOM for UTF-16, a byte Buffer for Latin-1, the string itself for UTF-8. */
export function encodeText(text, encoding = 'utf8') {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), swapBytes(Buffer.from(text, 'utf16le'))]);
  if (encoding === 'latin1') {
    // eslint-disable-next-line no-control-regex
    const bad = /[^\u0000-\u00ff]/u.exec(text);
    if (bad) throw Object.assign(new Error('This file is not UTF-8 (it was read as Latin-1, byte for byte), and the new text contains ' + JSON.stringify(bad[0]) + ', which Latin-1 cannot store. Nothing was written. Use only Latin-1 characters in this file, or convert it to UTF-8 first (for example with iconv) if the user wants that.'), { code: 'OASIS_ENCODING_UNREPRESENTABLE' });
    return Buffer.from(text, 'latin1');
  }
  return text;
}

/** Read a file as text with its encoding. */
export async function readTextFile(file) {
  return decodeText(await readFile(file));
}
