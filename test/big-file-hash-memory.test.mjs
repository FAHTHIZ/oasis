// read_file shows only the start of a big file, but the stale-edit check and
// read dedup hashed the whole file with readFile: reading a 400 MB log took
// the process to 575 MB. Big files are now hashed in chunks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, open, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashFile } from '../src/file-state.mjs';

const moduleUrl = (name) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', name)).href;

const SIZE = 256 * 1024 * 1024;

async function sparseFile(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-big-hash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'big.log');
  const handle = await open(file, 'w');
  await handle.write('start of the log\n', 0);
  await handle.truncate(SIZE);
  await handle.close();
  return { dir, file };
}

// Peak RSS (getrusage maxrss) in a fresh process: a sampled reading can miss a
// buffer that lives for a few milliseconds.
function peakGrowth(code, dir) {
  const script = "const before = process.resourceUsage().maxRSS;\n" + code + "\nconsole.log(JSON.stringify({ grew: (process.resourceUsage().maxRSS - before) * 1024, ok }));";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

test('hashFile matches a whole-file SHA-256 on both sides of the streaming limit', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-hash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const size of [100, 4 * 1024 * 1024 + 1, 9 * 1024 * 1024 + 7]) {
    const data = Buffer.alloc(size, 'ab\n');
    const file = path.join(dir, 'f' + size);
    await writeFile(file, data);
    assert.equal(await hashFile(file, size), createHash('sha256').update(data).digest('hex'));
  }
});

test('recording the state of a 256 MB file does not load it into memory', async (t) => {
  const { dir, file } = await sparseFile(t);
  const { grew, ok } = peakGrowth("const { recordFileState } = await import(" + JSON.stringify(moduleUrl('file-state.mjs')) + ");\n" +
    "const session = { config: {}, root: process.cwd(), messages: [] };\n" +
    "await recordFileState({ session, env: {} }, " + JSON.stringify(file) + ", { partial: 'lines 1-1' });\n" +
    "const ok = Boolean(session.fileState.get(" + JSON.stringify(file) + ").sha256);", dir);
  assert.equal(ok, true);
  assert.ok(grew < SIZE / 4, 'memory grew by ' + Math.round(grew / 1048576) + ' MB');
});

test('read dedup on a 256 MB file does not load it into memory', async (t) => {
  const { dir } = await sparseFile(t);
  const { grew, ok } = peakGrowth("const { recordDedupedRead } = await import(" + JSON.stringify(moduleUrl('read-dedup.mjs')) + ");\n" +
    "const session = { config: {}, root: process.cwd(), messages: [] };\n" +
    "await recordDedupedRead(session, { path: 'big.log' }, 'call-1', { content: 'x'.repeat(600), result: { path: 'big.log', content: 'y'.repeat(600) } }, {});\n" +
    "const ok = session.readDedupCache.size === 1;", dir);
  assert.equal(ok, true);
  assert.ok(grew < SIZE / 4, 'memory grew by ' + Math.round(grew / 1048576) + ' MB');
});
