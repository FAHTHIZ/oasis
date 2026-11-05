import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readWorkspaceFile } from '../src/tools.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bigread-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a file over 256 KiB without a range returns its first 2000 lines and a note', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'log.txt'), Array.from({ length: 5000 }, (_, i) => 'line ' + (i + 1) + ' ' + 'x'.repeat(60)).join('\n'));
  const read = await readWorkspaceFile(root, 'log.txt');
  assert.equal(read.startLine, 1);
  assert.equal(read.endLine, 2000);
  assert.equal(read.totalLines, 5000);
  assert.equal(read.truncated, true);
  assert.match(read.note, /showing lines 1-2000 of 5000.*offset and limit/);
});

test('one huge line is cut at 2000 characters instead of filling the context', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'min.js'), 'a'.repeat(500000));
  const read = await readWorkspaceFile(root, 'min.js');
  assert.ok(read.content.length < 2100, String(read.content.length));
  assert.match(read.note, /long lines cut at 2000/);
});

test('files over 4 MiB are read as a stream, at any offset', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'huge.log'), Array.from({ length: 60000 }, (_, i) => 'row ' + (i + 1) + ' ' + 'y'.repeat(80)).join('\n'));
  const first = await readWorkspaceFile(root, 'huge.log');
  assert.equal(first.content.split('\n')[0].startsWith('row 1 '), true);
  assert.equal(first.endLine, 2000);
  assert.equal(first.totalLines, undefined);
  const later = await readWorkspaceFile(root, 'huge.log', { offset: 59999, limit: 10 });
  assert.deepEqual(later.content.split('\n').map((line) => line.split(' ')[1]), ['59999', '60000']);
  assert.equal(later.totalLines, 60000);
  await writeFile(path.join(root, 'huge.bin'), Buffer.concat([Buffer.alloc(10), Buffer.alloc(5 * 1024 * 1024, 65)]));
  await assert.rejects(readWorkspaceFile(root, 'huge.bin'), /binary/);
});

test('a missing program reads as "Command not found"', async () => {
  const { runWorkspaceCommand, spawnErrorText } = await import('../src/tools.mjs');
  assert.match(spawnErrorText(Object.assign(new Error('spawn nope-xyz ENOENT'), { code: 'ENOENT', path: 'nope-xyz' }), 'nope-xyz'), /^Command not found: nope-xyz\. It is not installed or not on PATH/);
  assert.equal(spawnErrorText(new Error('other'), 'x'), 'other');
  void runWorkspaceCommand;
});

test('oversized results stay valid JSON; reads say exactly which lines were shown', async () => {
  const { fitLargeResult } = await import('../src/agent.mjs');
  const content = Array.from({ length: 2000 }, (_, i) => 'line ' + (i + 1) + ' "quoted" ' + 'x'.repeat(70)).join('\n');
  const fitted = JSON.parse(fitLargeResult({ path: 'big.txt', content, startLine: 1, endLine: 2000, totalLines: 200000, truncated: true }, 24000));
  assert.ok(fitted.endLine > 100 && fitted.endLine < 2000, String(fitted.endLine));
  assert.equal(fitted.content.split('\n').length, fitted.endLine);
  assert.match(fitted.note, new RegExp('Showing lines 1-' + fitted.endLine + ' of 200000.*offset=' + (fitted.endLine + 1)));
  const whole = JSON.parse(fitLargeResult({ path: 'mid.mjs', content }, 24000));
  assert.equal(whole.totalLines, 2000);
  const command = fitLargeResult({ command: 'seq', exitCode: 0, stdout: '"x"\n'.repeat(20000), stderr: '' }, 24000);
  const parsed = JSON.parse(command);
  assert.ok(command.length <= 24200);
  assert.match(parsed.stdout, /characters cut from the middle/);
  assert.equal(parsed.exitCode, 0);
});
