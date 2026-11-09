import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { searchWorkspaceFiles } from '../src/tools.mjs';
import { resolveRipgrep } from '../src/ripgrep.mjs';

test('search_files explains an empty result and retries regex-looking queries as a regex', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-search-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'lib.mjs'), 'export function sliceLines(text) {\n  return text;\n}\n');
  const empty = await searchWorkspaceFiles(root, 'parseBooleanFlag');
  assert.deepEqual(empty.matches, []);
  assert.match(empty.hint, /literal, case-insensitive/);
  assert.match(empty.hint, /create it/);
  const many = await searchWorkspaceFiles(root, 'function that slices lines of text');
  assert.match(many.hint, /6 words/);
  if (!resolveRipgrep(process.env)) return; // the regex retry uses ripgrep
  const regex = await searchWorkspaceFiles(root, 'sliceLines|parseBooleanFlag');
  assert.equal(regex.matches.length, 1);
  assert.equal(regex.matches[0].path, 'src/lib.mjs');
  assert.match(regex.note || '', /regular expression/);
  const found = await searchWorkspaceFiles(root, 'sliceLines');
  assert.equal(found.hint, undefined);
});
