import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { extractPdfPages, parsePageRange } from '../src/pdf.mjs';
import { executeTool } from '../src/tools.mjs';

// Builds a small, valid two-page PDF with Flate-compressed content streams.
function makePdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const streamCount = pages.reduce((sum, page) => sum + (Array.isArray(page[0]) ? page.length : 1), 0);
  const parentIndex2 = objects.length + streamCount + pages.length + 1;
  for (const page of pages) {
    const streams = Array.isArray(page[0]) ? page : [page];
    const contents = streams.map((lines, part) => {
      const stream = 'BT /F1 12 Tf 72 ' + (720 - part * 200) + ' Td ' + lines.map((line, index) => (index ? '0 -16 Td ' : '') + '(' + line.replace(/[()\\]/g, '\\$&') + ') Tj').join(' ') + ' ET';
      const data = deflateSync(Buffer.from(stream, 'latin1'));
      return add({ dict: '<< /Length ' + data.length + ' /Filter /FlateDecode >>', data });
    });
    pageIds.push(add('<< /Type /Page /Parent ' + parentIndex2 + ' 0 R /MediaBox [0 0 612 792] /Contents [' + contents.map((id) => id + ' 0 R').join(' ') + '] /Resources << /Font << /F1 ' + font + ' 0 R >> >> >>'));
  }
  const pagesId = add('<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>');
  assert.equal(pagesId, parentIndex2);
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

test('pdf.js extracts text per page, including pages with several content streams', async () => {
  const { totalPages, pages } = await extractPdfPages(makePdf([['Invoice 42', 'Total: $10 (paid)'], [['Second page'], ['more text']]]));
  assert.equal(totalPages, 2);
  assert.match(pages[0], /Invoice 42\s+Total: \$10 \(paid\)/);
  assert.match(pages[1], /Second page[\s\S]*more text/);
  await assert.rejects(extractPdfPages(Buffer.from('hello')), /does not look like a PDF/);
});

test('read_file returns PDF text with page markers, with or without pdftotext', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-pdf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'doc.pdf'), makePdf([['Alpha page one'], ['Beta page two'], ['Gamma page three']]));
  const fallback = await executeTool('read_file', { path: 'doc.pdf' }, { root, env: { ...process.env, OASIS_PDFTOTEXT: path.join(root, 'missing-pdftotext') } });
  assert.equal(fallback.method, 'pdf.js');
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
