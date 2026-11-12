import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseNumstat, collectDiff, bodyLines, renderFrame, applyKey, fileStarts, openLiveDiffPane } from '../src/live-diff.mjs';

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'oasis-live-diff-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args) => spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(path.join(root, 'a.txt'), 'one\n');
  writeFileSync(path.join(root, 'b.txt'), 'two\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return { root, env };
}

test('numstat parsing handles text and binary files', () => {
  assert.deepEqual(parseNumstat('3\t1\tsrc/a.js\n-\t-\timg.png\n'), [
    { path: 'src/a.js', added: 3, removed: 1, binary: false },
    { path: 'img.png', added: 0, removed: 0, binary: true }
  ]);
});

test('the live diff sees edits and untracked files, and its signature changes with them', () => {
  const { root, env } = repo();
  const clean = collectDiff(root, { env });
  assert.deepEqual(bodyLines(clean), ['No uncommitted changes. Waiting for edits…']);
  appendFileSync(path.join(root, 'a.txt'), 'added\n');
  appendFileSync(path.join(root, 'b.txt'), 'more\n');
  writeFileSync(path.join(root, 'new.txt'), 'x\n');
  const dirty = collectDiff(root, { env });
  assert.notEqual(dirty.signature, clean.signature);
  assert.deepEqual(dirty.files.map((file) => file.path), ['a.txt', 'b.txt']);
  assert.deepEqual(dirty.untracked, ['new.txt']);
  const lines = bodyLines(dirty);
  assert.ok(lines.includes('+added'));
  assert.equal(fileStarts(lines).length, 2);
  assert.deepEqual(bodyLines(dirty, { stat: true }).slice(0, 2), ['+1 -0       a.txt', '+1 -0       b.txt']);
  assert.deepEqual(collectDiff(root, { env, paths: ['b.txt'] }).files.map((file) => file.path), ['b.txt']);
});

test('frames fit the terminal and keys scroll, jump between files and toggle modes', () => {
  const { root, env } = repo();
  for (let i = 0; i < 30; i++) appendFileSync(path.join(root, 'a.txt'), 'line ' + i + ' ' + 'x'.repeat(120) + '\n');
  appendFileSync(path.join(root, 'b.txt'), 'b change\n');
  const diff = collectDiff(root, { env });
  const view = { scroll: 0, stat: false, paused: false };
  const frame = renderFrame(diff, view, { cols: 60, rows: 12, color: false, now: new Date(2026, 0, 1, 9, 30, 0) });
  const rows = frame.split('\r\n');
  assert.equal(rows.length, 12);
  assert.ok(rows.every((row) => row.length <= 60), 'every row fits');
  assert.match(rows[0], /2 changed {2}\+31 -0 {2}updated 09:30:00/);
  const lines = bodyLines(diff, view);
  applyKey(view, 'n', lines, 12);
  assert.equal(view.scroll, fileStarts(lines)[1] > lines.length - 10 ? lines.length - 10 : fileStarts(lines)[1]);
  applyKey(view, 'g', lines, 12);
  assert.equal(view.scroll, 0);
  applyKey(view, 'j', lines, 12);
  assert.equal(view.scroll, 1);
  applyKey(view, 'w', lines, 12);
  assert.equal(view.paused, true);
  assert.match(renderFrame(diff, view, { cols: 80, rows: 12, color: false }).split('\r\n')[0], /paused/);
  applyKey(view, 's', lines, 12);
  assert.equal(view.stat, true);
  assert.equal(applyKey(view, 'q', lines, 12), 'quit');
});

test('/diff --watch opens a tmux pane only inside tmux', () => {
  const outside = openLiveDiffPane({ root: tmpdir(), env: {} });
  assert.equal(outside.opened, false);
  assert.match(outside.message, /oasis diff --watch/);
});
