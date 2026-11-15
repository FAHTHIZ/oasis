// Seven eval tasks had verifiers that import src/lib.mjs, a file that is not
// in the task snapshot and that task.md never named, so a correct solution in
// any other file failed (ttl-cache also required a chainable set() it never
// mentioned). Every module a verifier imports must already exist in the task
// snapshot or be named in task.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../evals');

test('eval verifiers only import files that exist or that task.md names', () => {
  const problems = [];
  for (const id of readdirSync(path.join(EVALS, 'tasks'))) {
    const dir = path.join(EVALS, 'tasks', id);
    const verifier = path.join(dir, 'verify.mjs');
    if (!existsSync(verifier)) continue;
    const marker = path.join(dir, 'repo', 'BASE_SNAPSHOT');
    const repo = existsSync(marker) ? path.join(EVALS, 'snapshots', readFileSync(marker, 'utf8').trim()) : path.join(dir, 'repo');
    const task = readFileSync(path.join(dir, 'task.md'), 'utf8');
    const source = readFileSync(verifier, 'utf8');
    for (const match of source.matchAll(/import\(\s*pathToFileURL\(\s*path\.join\(\s*root\s*,\s*'([^']+)'\s*\)\s*\)/g)) {
      const rel = match[1];
      if (!existsSync(path.join(repo, rel)) && !task.includes(rel)) problems.push(id + ': verifier imports ' + rel + ', which is not in the snapshot and not named in task.md');
    }
  }
  assert.deepEqual(problems, []);
});
