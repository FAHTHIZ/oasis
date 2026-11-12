import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// History files describe removed things on purpose; current docs must not.
const HISTORY = new Set(['MISSION-LOG.md']);
const PATH = /`((?:src|app|ide|desktop|scripts|test|assets|docs|bench|evals|plugins|skills)\/[\w./-]+\.\w+)`/g;

test('current docs only name repository files that exist', () => {
  const files = readdirSync(path.join(root, 'docs')).filter((name) => name.endsWith('.md') && !HISTORY.has(name)).map((name) => path.join('docs', name));
  files.push('README.md');
  const missing = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(PATH)) if (!existsSync(path.join(root, match[1]))) missing.push(file + ': ' + match[1]);
  }
  assert.deepEqual(missing, []);
});
