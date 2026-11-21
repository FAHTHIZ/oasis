// Read-before-edit and stale-file protection, matching Claude Code's file-state rules:
//  - an existing file must be read (fully or partially) in this session before it is
//    overwritten (and, with requireReadBeforeEdit: "strict", before any edit), so the
//    model never replaces code it has not seen;
//  - if the file changed on disk after it was read (by the user, a formatter, a
//    command, or another agent), the edit is refused until the model re-reads it.
// The agent's own successful writes refresh the record, so chained edits work.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

const WHOLE_READ_LIMIT = 4 * 1024 * 1024;
// Small text files keep a copy of what the model last saw, so a stale-edit
// refusal can show exactly what changed on disk instead of forcing a full
// re-read (one tool round trip, and the whole file back into context).
const SNAPSHOT_FILE_LIMIT = 256 * 1024;
const SNAPSHOT_TOTAL_LIMIT = 8 * 1024 * 1024;
const STALE_DIFF_MAX_LINES = 80;
const STALE_DIFF_MAX_HUNKS = 6;
// read_file streams big files and returns only their start, but the hashes for
// stale-edit checks and read dedup used to load the whole file: reading a 400 MB
// log took the process to 575 MB. Files above the limit are hashed in chunks.
export async function hashFile(absolute, size) {
  const digest = createHash('sha256');
  if (size <= WHOLE_READ_LIMIT) return digest.update(await readFile(absolute)).digest('hex');
  for await (const chunk of createReadStream(absolute, { highWaterMark: 1024 * 1024 })) digest.update(chunk);
  return digest.digest('hex');
}

function fileStateEnabled(context = {}) {
  const session = context.session;
  if (!session || typeof session !== 'object') return false;
  const env = context.env || process.env;
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_REQUIRE_READ_BEFORE_EDIT || ''))) return false;
  const config = session.config || context.config || {};
  return config.requireReadBeforeEdit !== false;
}

function store(context) {
  const session = context.session;
  if (!(session.fileState instanceof Map)) {
    Object.defineProperty(session, 'fileState', { value: new Map(), writable: true, configurable: true, enumerable: false });
  }
  return session.fileState;
}

/** Record the on-disk state of a file the model has just seen or written. */
export async function recordFileState(context, absolute, options = {}) {
  if (!fileStateEnabled(context)) return;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return;
    let sha256;
    let snapshot;
    if (info.size <= SNAPSHOT_FILE_LIMIT) {
      const buffer = await readFile(absolute);
      sha256 = createHash('sha256').update(buffer).digest('hex');
      snapshot = textSnapshot(buffer);
    } else sha256 = await hashFile(absolute, info.size);
    const previous = store(context).get(absolute);
    // A ranged re-read of a file already seen in full (unchanged) keeps it "fully read".
    const partial = options.partial && !(previous && previous.sha256 === sha256 && !previous.partial) ? options.partial : '';
    const records = store(context);
    records.delete(absolute);
    records.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, sha256, ...(partial ? { partial } : {}), ...(snapshot !== undefined ? { snapshot } : {}) });
    trimSnapshots(records);
  } catch { /* unreadable files simply stay untracked */ }
}

function textSnapshot(buffer) {
  if (buffer.includes(0)) return undefined;
  const text = buffer.toString('utf8');
  return text.includes('\uFFFD') ? undefined : text;
}

// Keep at most SNAPSHOT_TOTAL_LIMIT of snapshot text; the oldest records lose
// their snapshot first (they still keep the hash, so freshness checks work).
function trimSnapshots(records) {
  let total = 0;
  for (const record of records.values()) if (record.snapshot) total += record.snapshot.length;
  for (const record of records.values()) {
    if (total <= SNAPSHOT_TOTAL_LIMIT) break;
    if (!record.snapshot) continue;
    total -= record.snapshot.length;
    delete record.snapshot;
  }
}

/**
 * Line hunks that turn `before` into `after`: [{ oldStart, oldLines, newStart, lines }],
 * 1-based. Common head and tail are trimmed first; the middle is aligned with an
 * LCS when it is small enough, otherwise reported as one hunk.
 */
export function lineHunks(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (!x.length && !y.length) return [];
  if (x.length * y.length > 1_000_000) return [{ oldStart: head + 1, oldLines: x.length, newStart: head + 1, lines: y }];
  const n = x.length, m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const hunks = [];
  let current = null;
  let i = 0, j = 0;
  const open = () => { if (!current) current = { oldStart: head + i + 1, oldLines: 0, newStart: head + j + 1, lines: [] }; };
  const close = () => { if (current) { hunks.push(current); current = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { close(); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { open(); current.lines.push(y[j]); j++; }
    else { open(); current.oldLines++; i++; }
  }
  close();
  return hunks;
}

function describeHunks(hunks) {
  return hunks.map((hunk) => {
    const end = hunk.newStart + hunk.lines.length - 1;
    const where = hunk.lines.length
      ? 'Lines ' + hunk.newStart + (end > hunk.newStart ? '-' + end : '') + ' now read' + (hunk.oldLines ? ' (replacing ' + hunk.oldLines + ' old line' + (hunk.oldLines === 1 ? '' : 's') + ')' : ' (inserted)') + ':'
      : hunk.oldLines + ' line' + (hunk.oldLines === 1 ? ' was' : 's were') + ' deleted before line ' + hunk.newStart + '.';
    const width = String(Math.max(end, 1)).length;
    return [where, ...hunk.lines.map((line, index) => String(hunk.newStart + index).padStart(width, ' ') + '| ' + line.replace(/\r$/, ''))].join('\n');
  }).join('\n');
}

export function forgetFileState(context, absolute) {
  if (fileStateEnabled(context)) store(context).delete(absolute);
}

/**
 * Throw a model-actionable error if an existing file has not been read, or has
 * changed since it was read. Missing files (new-file creation) always pass.
 */
export async function assertFileFresh(context, absolute, relative, options = {}) {
  if (!fileStateEnabled(context)) return;
  let info;
  try { info = await stat(absolute); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile()) return;
  const record = store(context).get(absolute);
  if (!record) {
    const config = (context.session && context.session.config) || context.config || {};
    const env = context.env || process.env;
    const strict = config.requireReadBeforeEdit === 'strict' || /^strict$/i.test(String(env.OASIS_REQUIRE_READ_BEFORE_EDIT || ''));
    // An exact-string edit already proves the model knows the text it replaces;
    // full overwrites (and every edit in strict mode) require a prior read.
    if (options.exactMatch && !strict) return;
    throw new Error('File has not been read yet: ' + relative + '. Read it with read_file before editing or overwriting it, so the change is based on its current contents.');
  }
  if (options.fullOverwrite && record.partial) {
    throw new Error('Only part of ' + relative + ' has been read (' + record.partial + '). Overwriting it with write_file would replace lines you have not seen. ' +
      'Read the whole file first, or change just the relevant section with edit_file / multi_edit.');
  }
  if (record.mtimeMs === info.mtimeMs && record.size === info.size) return;
  const current = await hashFile(absolute, info.size);
  if (current === record.sha256) { record.mtimeMs = info.mtimeMs; record.size = info.size; return; }
  if (typeof record.snapshot === 'string' && info.size <= SNAPSHOT_FILE_LIMIT) {
    const buffer = await readFile(absolute).catch(() => null);
    const now = buffer && textSnapshot(buffer);
    if (typeof now === 'string') {
      const hunks = lineHunks(record.snapshot, now);
      const changed = hunks.reduce((sum, hunk) => sum + Math.max(hunk.lines.length, 1), 0);
      if (hunks.length && hunks.length <= STALE_DIFF_MAX_HUNKS && changed <= STALE_DIFF_MAX_LINES) {
        // The model now has everything that changed, so its view is current again:
        // refresh the record and let the very next edit go through.
        const records = store(context);
        records.delete(absolute);
        records.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, sha256: createHash('sha256').update(buffer).digest('hex'), ...(record.partial ? { partial: record.partial } : {}), snapshot: now });
        throw new Error('File has been modified since it was last read (by the user, a formatter/linter, a command, or another agent): ' + relative +
          '. No change was made. Here is everything that changed on disk since your read:\n' + describeHunks(hunks) +
          '\nYour view of the file is up to date again; redo the edit against this text (no re-read needed).');
      }
    }
  }
  throw new Error('File has been modified since it was last read (by the user, a formatter/linter, a command, or another agent): ' + relative + '. Read it again with read_file and base the edit on the new contents.');
}
