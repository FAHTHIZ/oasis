import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { checkEvalQuarantine } from '../.github/scripts/check-eval-quarantine.mjs';

async function createRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-quarantine-test-'));
  const taskDir = path.join(root, 'evals', 'tasks', 'fixture-task');
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, 'task.md'), 'Change the greeting but preserve the exported API.\n');
  return root;
}

test('quarantine accepts clean text data and scans nested training directories', async (t) => {
  const root = await createRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const training = path.join(root, 'data', 'training');
  await mkdir(training, { recursive: true });
  await writeFile(path.join(training, 'dialogues.jsonl'), JSON.stringify({
    messages: [{ role: 'user', content: 'Summarize this unrelated project.' }]
  }) + '\n');

  const report = await checkEvalQuarantine(root);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.promptsChecked, 1);
  assert.deepEqual(report.protectedDirectories, ['data/training']);
  assert.equal(report.scannedFiles, 1);
});

test('quarantine detects an exact task prompt inside nested JSON training data', async (t) => {
  const root = await createRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const training = path.join(root, 'train');
  await mkdir(training, { recursive: true });
  await writeFile(path.join(training, 'dialogues.jsonl'), JSON.stringify({
    messages: [{ role: 'user', content: 'Change the greeting but preserve the exported API.' }]
  }) + '\n');

  const report = await checkEvalQuarantine(root);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /exact benchmark prompt match/);
  assert.doesNotMatch(report.errors.join('\n'), /Change the greeting but preserve/);
});

test('quarantine recognizes underscore and dataset aliases for training directories', async (t) => {
  const root = await createRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const training = path.join(root, 'data', 'train_data');
  await mkdir(training, { recursive: true });
  await writeFile(path.join(training, 'dialogues.jsonl'), JSON.stringify({
    messages: [{ role: 'user', content: 'Change the greeting but preserve the exported API.' }]
  }) + '\\n');

  const report = await checkEvalQuarantine(root);
  assert.equal(report.ok, false);
  assert.deepEqual(report.protectedDirectories, ['data/train_data']);
  assert.match(report.errors.join('\\n'), /exact benchmark prompt match/);
});

test('quarantine checks snapshot directories for exact task prompt leakage', async (t) => {
  const root = await createRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'evals', 'snapshots', 'fixture');
  await mkdir(snapshot, { recursive: true });
  await writeFile(path.join(snapshot, 'README.md'), 'Old note: Change the greeting but preserve the exported API.\n');

  const report = await checkEvalQuarantine(root);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /exact benchmark prompt match/);
});

test('quarantine rejects unknown files in protected training directories', async (t) => {
  const root = await createRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const training = path.join(root, 'training');
  await mkdir(training, { recursive: true });
  await writeFile(path.join(training, 'opaque.bin'), Buffer.from([1, 2, 3, 4]));

  const report = await checkEvalQuarantine(root);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /unknown file type/);
});

test('quarantine rejects symbolic links in the repository scan', async (t) => {
  const root = await createRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const training = path.join(root, 'training');
  await mkdir(training, { recursive: true });
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'unrelated data');
  try {
    await symlink(outside, path.join(training, 'linked.txt'));
  } catch (error) {
    t.skip('symbolic links are unavailable in this environment: ' + error.message);
    return;
  }

  const report = await checkEvalQuarantine(root);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /symbolic links are not allowed/);
});

test('quarantine requires a prompt field in every frozen JSONL record', async (t) => {
  const root = await createRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frozenTasks = path.join(root, 'bench', 'tasks', 'frr');
  await mkdir(frozenTasks, { recursive: true });
  await writeFile(path.join(frozenTasks, 'turn_50_refactor.jsonl'), JSON.stringify({
    id: 'turn-50-refactor',
    task: 'A record with the wrong field name.'
  }) + '\n');

  const report = await checkEvalQuarantine(root);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /must contain a non-empty string field named prompt/);
});
