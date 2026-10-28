// Read-before-edit and stale-file protection, matching Claude Code's file-state rules:
//  - an existing file must be read (fully or partially) in this session before it is
//    overwritten (and, with requireReadBeforeEdit: "strict", before any edit), so the
//    model never replaces code it has not seen;
//  - if the file changed on disk after it was read (by the user, a formatter, a
//    command, or another agent), the edit is refused until the model re-reads it.
// The agent's own successful writes refresh the record, so chained edits work.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

function hash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

export function fileStateEnabled(context = {}) {
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
export async function recordFileState(context, absolute) {
  if (!fileStateEnabled(context)) return;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return;
    const content = await readFile(absolute);
    store(context).set(absolute, { mtimeMs: info.mtimeMs, size: info.size, sha256: hash(content) });
  } catch { /* unreadable files simply stay untracked */ }
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
  if (record.mtimeMs === info.mtimeMs && record.size === info.size) return;
  const current = hash(await readFile(absolute));
  if (current === record.sha256) { record.mtimeMs = info.mtimeMs; record.size = info.size; return; }
  throw new Error('File has been modified since it was last read (by the user, a formatter/linter, a command, or another agent): ' + relative + '. Read it again with read_file and base the edit on the new contents.');
}
