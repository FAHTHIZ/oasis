import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadMemory } from '../src/memory.mjs';

const env = (home) => ({ HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') });

test('oversized instruction files are truncated visibly with a notice', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-trunc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'CLAUDE.md'), 'start\n' + 'x'.repeat(12000) + '\nLAST RULE');
  const notices = [];
  const text = await loadMemory(root, { env: env(root), home: root, notices });
  assert.match(text, /CLAUDE\.md truncated: \d+ more characters not loaded/);
  assert.doesNotMatch(text, /LAST RULE/);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /CLAUDE\.md is \d+ characters; only the first 9000/);
});

test('README never crowds out real instruction files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-trunc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'README.md'), 'readme '.repeat(3000));
  await writeFile(path.join(root, 'CLAUDE.local.md'), 'LOCAL RULE: never touch prod');
  const notices = [];
  const text = await loadMemory(root, { env: env(root), home: root, notices });
  assert.ok(text.indexOf('LOCAL RULE') < text.indexOf('readme'), 'instructions come before README');
  assert.deepEqual(notices, [], 'a long README is not an instruction problem');
});

test('small files load untouched without notices', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-trunc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'AGENTS.md'), 'Use tabs.');
  const notices = [];
  const text = await loadMemory(root, { env: env(root), home: root, notices });
  assert.match(text, /Use tabs\.$/);
  assert.deepEqual(notices, []);
});
