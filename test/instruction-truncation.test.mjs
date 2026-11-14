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
  await writeFile(path.join(root, 'CLAUDE.md'), 'start\n' + 'x'.repeat(160000) + '\nLAST RULE');
  const notices = [];
  const text = await loadMemory(root, { env: env(root), home: root, notices });
  assert.match(text, /CLAUDE\.md truncated: \d+ more characters not loaded/);
  assert.doesNotMatch(text, /LAST RULE/);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /CLAUDE\.md is \d+ characters; only the first 150000/);
});

// The old 9,000-character cap cut an ordinary AGENTS.md short.
test('a long instruction file loads whole, with a size warning', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-trunc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'AGENTS.md'), 'start\n' + 'rule line\n'.repeat(5000) + 'LAST RULE');
  const notices = [];
  const text = await loadMemory(root, { env: env(root), home: root, notices });
  assert.match(text, /LAST RULE/);
  assert.doesNotMatch(text, /truncated/);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Large AGENTS\.md will use more context/);
  await writeFile(path.join(root, 'AGENTS.md'), 'short\n' + 'rule line\n'.repeat(1000) + 'LAST RULE');
  const quiet = [];
  assert.match(await loadMemory(root, { env: env(root), home: root, notices: quiet }), /LAST RULE/);
  assert.deepEqual(quiet, []);
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

test('a long README is clipped to its opening at a line boundary, with a pointer to the rest', async () => {
  const { clipReadme } = await import('../src/memory.mjs');
  const long = Array.from({ length: 200 }, (_, i) => 'Line ' + i + ' of the readme explains something.').join('\n');
  const out = clipReadme(long);
  assert.ok(out.length < 3700, String(out.length));
  assert.match(out, /^Line 0 /);
  assert.match(out, /\n\[README continues \(\d+ characters in all\); read_file README\.md for the rest\]$/);
  assert.match(out.split('\n').at(-2), /^Line \d+ of the readme explains something\.$/);
  assert.equal(clipReadme('short readme'), 'short readme');
});
