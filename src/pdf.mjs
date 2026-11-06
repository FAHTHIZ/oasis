// PDF reading for read_file. Uses poppler's pdftotext when it is installed
// (fast, keeps layout) and otherwise Mozilla's pdf.js through unpdf (MIT),
// which handles every font encoding, object streams and empty-password
// encryption, and splits text by page. unpdf is imported lazily.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

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

/** Text of each page via pdf.js (unpdf). Returns { totalPages, pages: string[] }. */
export async function extractPdfPages(buffer) {
  const bytes = new Uint8Array(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).indexOf('%PDF') < 0) throw new Error('This file does not look like a PDF.');
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  } catch (error) {
    if (error?.name === 'PasswordException') throw new Error('This PDF is password-protected.');
    throw new Error('Could not read this PDF: ' + (error?.message || error));
  }
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    return { totalPages, pages: text.map((page) => String(page).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')) };
  } finally {
    await pdf.destroy?.().catch?.(() => {});
  }
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
    method = 'pdf.js';
    const extracted = await extractPdfPages(await readFile(absolute));
    totalPages = extracted.totalPages;
    if (range && range.first > totalPages) throw new Error('This PDF has ' + totalPages + ' page' + (totalPages === 1 ? '' : 's') + '.');
    text = (range ? extracted.pages.slice(range.first - 1, range.last) : extracted.pages).join('\f');
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
    ...(empty ? { note: 'No extractable text: the PDF is probably scanned images.' } : {})
  };
}
