// PDF reading for read_file. Uses poppler's pdftotext when it is installed
// (accurate, keeps layout, supports page ranges) and falls back to a small
// built-in extractor that decodes Flate streams and text operators, which
// handles most PDFs produced by word processors, LaTeX and browsers.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { inflateSync, inflateRawSync } from 'node:zlib';

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 200000;
const MAX_PAGES_PER_READ = 50;

export function isPdfPath(file) {
  return /\.pdf$/i.test(String(file || ''));
}

export function parsePageRange(pages) {
  if (pages === undefined || pages === null || pages === '') return null;
  const match = String(pages).trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) throw new Error('pages must look like "3" or "1-10".');
  const first = Number(match[1]);
  const last = Number(match[2] || match[1]);
  if (first < 1 || last < first) throw new Error('pages must be a range like 1-10 with the first page at least 1.');
  if (last - first + 1 > MAX_PAGES_PER_READ) throw new Error('Read at most ' + MAX_PAGES_PER_READ + ' pages at a time.');
  return { first, last };
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, maxBuffer: 16 * 1024 * 1024, timeout: 60000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function pdfInfoPages(file, env) {
  try {
    const out = await run('pdfinfo', [file], env);
    const match = out.match(/^Pages:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

// ---------- built-in fallback ----------
function decodeLiteral(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== '\\') { out += char; continue; }
    const next = text[++i];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b' || next === 'f') out += '';
    else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(text[i + 1])) octal += text[++i];
      out += String.fromCharCode(parseInt(octal, 8));
    } else if (next === '\n' || next === '\r') { if (next === '\r' && text[i + 1] === '\n') i++; }
    else out += next;
  }
  return out;
}

function decodeHex(hex) {
  const clean = hex.replace(/\s+/g, '');
  const bytes = Buffer.from(clean.length % 2 ? clean + '0' : clean, 'hex');
  // Two-byte codes with a zero high byte are usually UTF-16BE text.
  if (bytes.length >= 2 && bytes.length % 2 === 0 && (bytes[0] === 0xfe && bytes[1] === 0xff || bytes.filter((_, index) => index % 2 === 0 && bytes[index] === 0).length >= bytes.length / 4)) {
    const start = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
    let out = '';
    for (let i = start; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
    return out;
  }
  return bytes.toString('latin1');
}

// Decodes a shown string with the current font's ToUnicode CMap when there is one.
function decodeShown(token, font) {
  const raw = token.str;
  if (font && font.map.size) {
    let out = '';
    const width = font.bytes;
    for (let i = 0; i < raw.length; i += width) {
      let code = 0;
      for (let j = 0; j < width; j++) code = code * 256 + (raw.charCodeAt(i + j) || 0);
      const mapped = font.map.get(code);
      out += mapped !== undefined ? mapped : (width === 1 ? raw[i] : '');
    }
    return out;
  }
  return token.hex ? decodeHex(Buffer.from(raw, 'latin1').toString('hex')) : raw;
}

function utf16hex(hex) {
  const bytes = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
  return out;
}

export function parseToUnicode(cmap) {
  const map = new Map();
  let bytes = 1;
  const space = cmap.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/);
  if (space) bytes = Math.max(1, Math.ceil(space[1].length / 2));
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(pair[1], 16), utf16hex(pair[2]));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const low = parseInt(range[1], 16);
      const high = Math.min(parseInt(range[2], 16), low + 65535);
      if (range[4] !== undefined) {
        const start = Buffer.from(range[4].length % 2 ? range[4] + '0' : range[4], 'hex');
        for (let code = low; code <= high; code++) {
          const target = Buffer.from(start);
          target.writeUInt16BE((target.readUInt16BE(target.length - 2) + (code - low)) & 0xffff, target.length - 2);
          map.set(code, utf16hex(target.toString('hex')));
        }
      } else {
        const items = [...range[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((item) => utf16hex(item[1]));
        items.forEach((value, index) => { if (low + index <= high) map.set(low + index, value); });
      }
    }
  }
  return { map, bytes };
}

function readString(source, start) {
  // Returns [decoded, endIndex] for a literal string starting at "(".
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') { i++; continue; }
    if (char === '(') depth++;
    else if (char === ')') { depth--; if (depth === 0) return [decodeLiteral(source.slice(start + 1, i)), i]; }
  }
  return ['', source.length];
}

export function extractTextFromContentStream(source, fonts = {}) {
  let font = null;
  const show = (token) => decodeShown(token, font);
  let out = '';
  let pending = [];
  const flush = (separator = '') => { if (pending.length) { out += pending.join(''); pending = []; } out += separator; };
  let i = 0;
  const tokens = [];
  while (i < source.length) {
    const char = source[i];
    if (char === '(') { const [text, end] = readString(source, i); tokens.push({ str: text, hex: false }); i = end + 1; continue; }
    if (char === '<' && source[i + 1] !== '<') { const end = source.indexOf('>', i); const clean = source.slice(i + 1, end < 0 ? source.length : end).replace(/\s+/g, ''); tokens.push({ str: Buffer.from(clean.length % 2 ? clean + '0' : clean, 'hex').toString('latin1'), hex: true }); i = end < 0 ? source.length : end + 1; continue; }
    if (char === '[') { tokens.push({ open: true }); i++; continue; }
    if (char === ']') { tokens.push({ close: true }); i++; continue; }
    if (/\s/.test(char)) { i++; continue; }
    const match = source.slice(i).match(/^[^\s()<>\[\]/%]+|^\/[^\s()<>\[\]/%]*|^%[^\n]*|^<<|^>>/);
    if (!match) { i++; continue; }
    const word = match[0];
    i += word.length;
    if (word.startsWith('%')) continue;
    if (/^-?\d*\.?\d+$/.test(word)) { tokens.push({ num: Number(word) }); continue; }
    if (word.startsWith('/')) { tokens.push({ name: word.slice(1) }); continue; }
    tokens.push({ op: word });
  }
  let inArray = false;
  let arrayParts = [];
  let operands = [];
  for (const token of tokens) {
    if (token.open) { inArray = true; arrayParts = []; continue; }
    if (token.close) { inArray = false; operands.push({ array: arrayParts }); continue; }
    if (inArray) {
      if (token.str !== undefined) arrayParts.push(show(token));
      else if (token.num !== undefined && token.num < -200) arrayParts.push(' ');
      continue;
    }
    if (token.op === undefined) { operands.push(token); continue; }
    const op = token.op;
    if (op === 'Tj' || op === "'" || op === '"') {
      if (op !== 'Tj') flush('\n');
      const last = operands.reverse().find((item) => item.str !== undefined);
      if (last) pending.push(show(last));
    } else if (op === 'TJ') {
      const last = operands.reverse().find((item) => item.array);
      if (last) pending.push(last.array.join(''));
    } else if (op === 'Td' || op === 'TD') {
      const y = operands.length >= 2 ? operands[operands.length - 1].num : 0;
      const x = operands.length >= 2 ? operands[operands.length - 2].num : 0;
      flush(Math.abs(y || 0) > 0.5 ? '\n' : (x > 0 ? ' ' : ''));
    } else if (op === 'Tf') {
      const name = operands.find((item) => item.op === undefined && item.name);
      font = name ? fonts[name.name] || null : null;
    } else if (op === 'T*' || op === 'ET') flush('\n');
    else if (op === 'Tm') flush('\n');
    operands = [];
  }
  flush();
  return out;
}

function streamOf(buffer, raw, body, bodyStart) {
  const at = body.search(/stream\r?\n/);
  if (at < 0) return null;
  const dict = body.slice(0, at);
  const start = bodyStart + at + body.slice(at).match(/^stream\r?\n/)[0].length;
  const lengthMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
  let end = lengthMatch ? start + Number(lengthMatch[1]) : raw.indexOf('endstream', start);
  if (end < start) end = raw.indexOf('endstream', start);
  let data = buffer.subarray(start, end);
  if (/FlateDecode/.test(dict)) { try { data = inflateSync(data); } catch { try { data = inflateRawSync(data); } catch { return null; } } }
  return data.toString('latin1');
}

// Maps font resource names (/F1) to their ToUnicode CMaps.
function pdfFonts(buffer, raw) {
  const objects = new Map();
  for (const match of raw.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) objects.set(Number(match[1]), { body: match[2], start: match.index + match[0].indexOf(match[2]) });
  const cmapFor = new Map();
  for (const [number, object] of objects) {
    const ref = object.body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (!ref || !/\/Type\s*\/Font/.test(object.body)) continue;
    const target = objects.get(Number(ref[1]));
    const text = target && streamOf(buffer, raw, target.body, target.start);
    if (text) cmapFor.set(number, parseToUnicode(text));
  }
  const fonts = {};
  if (!cmapFor.size) return fonts;
  const addEntries = (dict) => {
    for (const entry of dict.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+0\s+R/g)) if (cmapFor.has(Number(entry[2]))) fonts[entry[1]] = cmapFor.get(Number(entry[2]));
  };
  for (const object of objects.values()) {
    const inline = object.body.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (inline) addEntries(inline[1]);
    const indirect = object.body.match(/\/Font\s+(\d+)\s+0\s+R/);
    if (indirect && objects.get(Number(indirect[1]))) addEntries(objects.get(Number(indirect[1])).body);
  }
  return fonts;
}

export function extractPdfTextBuiltin(buffer) {
  const raw = buffer.toString('latin1');
  if (!raw.startsWith('%PDF')) throw new Error('This file does not look like a PDF.');
  if (/\/Encrypt\s/.test(raw)) throw new Error('This PDF is encrypted. Install poppler (pdftotext) or open it in a PDF viewer to read it.');
  const parts = [];
  const fonts = pdfFonts(buffer, raw);
  const streamPattern = /(<<(?:(?!>>\s*stream)[\s\S]){0,4000}>>)\s*stream\r?\n/g;
  let match;
  while ((match = streamPattern.exec(raw))) {
    const dict = match[1];
    const start = match.index + match[0].length;
    const lengthMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    let end = lengthMatch ? start + Number(lengthMatch[1]) : raw.indexOf('endstream', start);
    if (end < start || end > raw.length) end = raw.indexOf('endstream', start);
    if (end < 0) break;
    streamPattern.lastIndex = end;
    if (/\/Subtype\s*\/(Image|Form)|\/Type\s*\/(XObject|XRef|ObjStm|Metadata|FontFile)|\/Length1|\/FontFile/.test(dict)) continue;
    if (/\/Filter\s*\[?\s*\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) continue;
    let data = buffer.subarray(start, end);
    if (/FlateDecode/.test(dict)) {
      try { data = inflateSync(data); } catch { try { data = inflateRawSync(data); } catch { continue; } }
    } else if (/\/Filter/.test(dict)) continue;
    const text = data.toString('latin1');
    if (!/\bBT\b/.test(text)) continue;
    parts.push(extractTextFromContentStream(text, fonts));
  }
  return parts.join('\n\f').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function readPdf(absolute, relative, { pages = null, env = process.env } = {}) {
  const info = await stat(absolute);
  if (info.size > MAX_PDF_BYTES) throw new Error('PDF is larger than 32 MiB.');
  const range = parsePageRange(pages);
  let text = null;
  let method = 'pdftotext';
  let totalPages = null;
  try {
    const args = ['-layout', '-enc', 'UTF-8', ...(range ? ['-f', String(range.first), '-l', String(range.last)] : []), absolute, '-'];
    text = await run(env.OASIS_PDFTOTEXT || 'pdftotext', args, env);
    totalPages = await pdfInfoPages(absolute, env);
  } catch (error) {
    if (error && error.code !== 'ENOENT' && !/ENOENT|not found/i.test(String(error.message))) {
      if (/Incorrect password|encrypted/i.test(String(error.message))) throw new Error('This PDF is password-protected.');
    }
    method = 'built-in';
    const buffer = await readFile(absolute);
    text = extractPdfTextBuiltin(buffer);
    const pageCount = (buffer.toString('latin1').match(/\/Type\s*\/Page(?!s)\b/g) || []).length || null;
    const pagesText = text.split('\f');
    // Page markers are only reliable when each page has one text stream.
    if (pageCount && pagesText.length !== pageCount) {
      text = pagesText.join('\n');
      if (range) throw new Error('This PDF needs poppler (pdftotext) to read page ranges. Install it, or read the whole file without pages.');
      totalPages = pageCount;
      const content = text.slice(0, MAX_TEXT);
      return { path: relative, type: 'pdf', totalPages, method, content, ...(text.length > MAX_TEXT ? { truncated: true } : {}), ...(!content.trim() ? { note: 'No extractable text: the PDF is probably scanned images.' } : {}) };
    }
    totalPages = pageCount || pagesText.length;
    if (range) text = pagesText.slice(range.first - 1, range.last).join('\f');
  }
  const pageTexts = String(text).split('\f');
  if (!totalPages) totalPages = range ? null : pageTexts.filter((page, index) => page.trim() || index < pageTexts.length - 1).length;
  let content = pageTexts.map((page, index) => (pageTexts.length > 1 || range ? '--- page ' + ((range ? range.first : 1) + index) + ' ---\n' : '') + page.trim()).filter((page) => page.trim()).join('\n\n');
  const truncated = content.length > MAX_TEXT;
  if (truncated) content = content.slice(0, MAX_TEXT);
  const empty = !content.replace(/--- page \d+ ---/g, '').trim();
  return {
    path: relative,
    type: 'pdf',
    ...(totalPages ? { totalPages } : {}),
    ...(range ? { pages: range.first + '-' + range.last } : {}),
    method,
    content: empty ? '' : content,
    ...(truncated ? { truncated: true, note: 'Text was cut at 200,000 characters; pass pages (e.g. "1-10") to read a section.' } : {}),
    ...(empty ? { note: 'No extractable text: the PDF is probably scanned images.' + (method === 'built-in' ? ' Installing poppler (pdftotext) may help for unusual fonts.' : '') } : {})
  };
}
