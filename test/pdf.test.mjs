import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { extractPdfTextBuiltin, extractTextFromContentStream, parsePageRange, parseToUnicode } from '../src/pdf.mjs';
import { executeTool } from '../src/tools.mjs';

// Builds a small, valid two-page PDF with Flate-compressed content streams.
function makePdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const parentIndex = objects.length + pages.length * 2 + 1;
  for (const lines of pages) {
    const stream = 'BT /F1 12 Tf 72 720 Td ' + lines.map((line, index) => (index ? '0 -16 Td ' : '') + '(' + line.replace(/[()\\]/g, '\\$&') + ') Tj').join(' ') + ' ET';
    const data = deflateSync(Buffer.from(stream, 'latin1'));
    const content = add({ dict: '<< /Length ' + data.length + ' /Filter /FlateDecode >>', data });
    pageIds.push(add('<< /Type /Page /Parent ' + parentIndex + ' 0 R /MediaBox [0 0 612 792] /Contents ' + content + ' 0 R /Resources << /Font << /F1 ' + font + ' 0 R >> >> >>'));
  }
  const pagesId = add('<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>');
  assert.equal(pagesId, parentIndex);
  const catalog = add('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const parts = typeof object === 'string'
      ? [Buffer.from((index + 1) + ' 0 obj\n' + object + '\nendobj\n', 'latin1')]
      : [Buffer.from((index + 1) + ' 0 obj\n' + object.dict + '\nstream\n', 'latin1'), object.data, Buffer.from('\nendstream\nendobj\n', 'latin1')];
    for (const part of parts) { chunks.push(part); length += part.length; }
  });
  const xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + length + '\n%%EOF\n';
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

function hasPdftotext() {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('page ranges are validated', () => {
  assert.equal(parsePageRange(''), null);
  assert.deepEqual(parsePageRange('3'), { first: 3, last: 3 });
  assert.deepEqual(parsePageRange('2-4'), { first: 2, last: 4 });
  assert.throws(() => parsePageRange('5-2'), /range/);
  assert.throws(() => parsePageRange('1-80'), /at most 50/);
  assert.throws(() => parsePageRange('abc'), /pages must/);
});

test('the built-in extractor reads text operators', () => {
  assert.equal(extractTextFromContentStream('BT (Hello) Tj 0 -14 Td [(Wor) -50 (ld) -400 (again)] TJ ET').trim(), 'Hello\nWorld again');
  assert.equal(extractTextFromContentStream('BT <00480069> Tj ET').trim(), 'Hi');
  const text = extractPdfTextBuiltin(makePdf([['Invoice 42', 'Total: $10 (paid)'], ['Second page']]));
  assert.match(text, /Invoice 42\nTotal: \$10 \(paid\)/);
  assert.match(text, /Second page/);
  assert.throws(() => extractPdfTextBuiltin(Buffer.from('hello')), /does not look like a PDF/);
});

test('read_file returns PDF text with page markers, with or without pdftotext', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-pdf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'doc.pdf'), makePdf([['Alpha page one'], ['Beta page two'], ['Gamma page three']]));
  const fallback = await executeTool('read_file', { path: 'doc.pdf' }, { root, env: { ...process.env, OASIS_PDFTOTEXT: path.join(root, 'missing-pdftotext') } });
  assert.equal(fallback.method, 'built-in');
  assert.equal(fallback.totalPages, 3);
  assert.match(fallback.content, /--- page 1 ---\nAlpha page one[\s\S]*--- page 3 ---\nGamma page three/);
  const some = await executeTool('read_file', { path: 'doc.pdf', pages: '2-3' }, { root, env: { ...process.env, OASIS_PDFTOTEXT: path.join(root, 'missing-pdftotext') } });
  assert.doesNotMatch(some.content, /Alpha/);
  assert.match(some.content, /--- page 2 ---\nBeta page two/);
  if (hasPdftotext()) {
    const poppler = await executeTool('read_file', { path: 'doc.pdf', pages: '3' }, { root, env: process.env });
    assert.equal(poppler.method, 'pdftotext');
    assert.match(poppler.content, /--- page 3 ---\s*Gamma page three/);
    assert.equal(poppler.totalPages, 3);
  }
});

test('ToUnicode CMaps decode subset fonts (LibreOffice, Word, Chrome)', () => {
  const cmap = parseToUnicode('1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0048> <0002> <0069> endbfchar 1 beginbfrange <0003> <0005> <0061> endbfrange 1 beginbfrange <0006> <0007> [<263A> <00E9>] endbfrange');
  assert.equal(cmap.bytes, 2);
  assert.equal(cmap.map.get(4), 'b');
  assert.equal(cmap.map.get(6), '\u263a');
  const text = extractTextFromContentStream('BT /F1 12 Tf <000100020003000400050007> Tj ET', { F1: cmap });
  assert.equal(text.trim(), 'Hiabc\u00e9');
});
