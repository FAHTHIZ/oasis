// Read deduplication: when the model re-reads the same unchanged file range
// while its earlier read result is still present in the conversation, return a
// short pointer instead of resending the full content. This targets one of the
// largest sources of wasted context and cost in long coding sessions.
//
// Safety properties:
//  - only plain text reads (result has a string `content`) are cached;
//  - the file's current SHA-256 must equal the cached hash;
//  - the original tool result (by tool_call_id) must still exist, unaltered, in
//    session.messages, so compaction, rewind, or /clear invalidate it naturally;
//  - disable entirely with OASIS_READ_DEDUP=0 or config.readDedup === false.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MIN_BYTES = 512;

export function readDedupEnabled(session, env = process.env) {
  if (!session || typeof session !== 'object') return false;
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_READ_DEDUP || ''))) return false;
  const config = session.config || {};
  return config.readDedup !== false;
}

function cacheOf(session) {
  if (!(session.readDedupCache instanceof Map)) {
    Object.defineProperty(session, 'readDedupCache', { value: new Map(), writable: true, configurable: true, enumerable: false });
  }
  return session.readDedupCache;
}

function keyFor(root, args) {
  if (!args || typeof args.path !== 'string' || !args.path) return '';
  if (args.pages !== undefined) return '';
  const absolute = path.resolve(root || process.cwd(), args.path);
  return absolute + '\u0000' + (args.offset ?? '') + '\u0000' + (args.limit ?? '');
}

async function currentHash(absolute) {
  const info = await stat(absolute);
  if (!info.isFile()) return '';
  return createHash('sha256').update(await readFile(absolute)).digest('hex');
}

function toolResultStillPresent(session, toolCallId, contentHash) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== 'tool' || message.tool_call_id !== toolCallId) continue;
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    return createHash('sha256').update(content).digest('hex') === contentHash;
  }
  return false;
}

/** Returns a stub result when the read can be safely skipped, otherwise null. */
export async function dedupedReadHit(session, args, env = process.env) {
  if (!readDedupEnabled(session, env)) return null;
  const key = keyFor(session.root, args);
  if (!key) return null;
  const entry = cacheOf(session).get(key);
  if (!entry) return null;
  let hash;
  try { hash = await currentHash(entry.absolute); } catch { cacheOf(session).delete(key); return null; }
  if (hash !== entry.fileHash || !toolResultStillPresent(session, entry.toolCallId, entry.messageHash)) {
    cacheOf(session).delete(key);
    return null;
  }
  entry.hits = (entry.hits || 0) + 1;
  session.readDedupSavedBytes = (session.readDedupSavedBytes || 0) + entry.bytes;
  return {
    path: entry.displayPath,
    unchanged: true,
    message: 'File unchanged since your earlier read_file of this same range in this conversation; its full content is already in context above. ' +
      'Use that earlier result instead of re-reading. If you truly need a fresh copy, read a different offset/limit.'
  };
}

/** Record a completed text read so later identical reads can be deduplicated. */
export async function recordDedupedRead(session, args, toolCallId, toolMessage, env = process.env) {
  if (!readDedupEnabled(session, env) || !toolCallId || !toolMessage) return;
  const result = toolMessage.result;
  if (!result || typeof result !== 'object' || typeof result.content !== 'string' || result.unchanged) return;
  if (Buffer.byteLength(result.content, 'utf8') < MIN_BYTES) return;
  const key = keyFor(session.root, args);
  if (!key) return;
  const absolute = key.split('\u0000')[0];
  try {
    const fileHash = await currentHash(absolute);
    if (!fileHash) return;
    const content = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content ?? '');
    cacheOf(session).set(key, {
      absolute,
      displayPath: result.path || args.path,
      fileHash,
      toolCallId,
      messageHash: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(result.content, 'utf8')
    });
  } catch { /* unreadable: do not cache */ }
}
