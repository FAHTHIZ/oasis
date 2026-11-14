import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool, trackSearchMisses } from '../src/tools.mjs';

test('repeated empty searches escalate the hint; a match resets the count', () => {
  const session = {};
  const miss = (query) => trackSearchMisses(session, { query, matches: [], hint: 'No matches.' });
  assert.equal(miss('redactSecrets').hint, 'No matches.');
  assert.equal(miss('export function redact').hint, 'No matches.');
  const third = miss('[REDACTED]');
  assert.match(third.hint, /^3 searches in a row found nothing \("redactSecrets", "export function redact", "\[REDACTED\]"\)/);
  assert.match(third.hint, /Stop searching/);
  trackSearchMisses(session, { query: 'x', matches: [{ path: 'a', line: 1, text: 'x' }] });
  assert.equal(miss('again').hint, 'No matches.');
});

test('search_files through executeTool counts misses on the session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-miss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'hello world\n');
  const session = {};
  const run = (query) => executeTool('search_files', { query }, { root, session, autoApprove: true });
  await run('nope-one'); await run('nope-two');
  const third = await run('nope-three');
  assert.match(third.hint, /3 searches in a row found nothing/);
  const hit = await run('hello');
  assert.equal(hit.matches.length, 1);
  assert.equal(session.searchMisses.length, 0);
});
