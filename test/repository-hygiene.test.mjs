import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage', 'dist', 'release', '.next']);

async function collectPaths(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!relative && entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const current = relative ? path.posix.join(relative, entry.name) : entry.name;
    found.push(current);
    if (entry.isDirectory()) found.push(...await collectPaths(path.join(directory, entry.name), current));
  }
  return found;
}

test('repository paths have no case-insensitive collisions', async () => {
  const paths = await collectPaths(ROOT);
  const seen = new Map();
  const collisions = [];
  for (const entry of paths) {
    const key = entry.toLocaleLowerCase('en-US');
    const prior = seen.get(key);
    if (prior && prior !== entry) collisions.push([prior, entry]);
    else seen.set(key, entry);
  }
  assert.deepEqual(
    collisions,
    [],
    'Paths that differ only by case cannot be checked out reliably on common Windows/macOS filesystems.'
  );
});
