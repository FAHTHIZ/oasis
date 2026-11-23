import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ddmin, keyErrorLine, restorePendingMinimize, runMinimizeRepro, splitUnits } from '../src/minimize-repro.mjs';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));

// A tiny "parser": braces must balance (else a SyntaxError, a different
// failure), and a BOOM line together with a TRIGGER line crashes it.
const PARSER = "import { readFileSync } from 'node:fs';\n"
  + "const text = readFileSync(process.argv[2], 'utf8');\n"
  + "const open = (text.match(/\\{/g) || []).length, close = (text.match(/\\}/g) || []).length;\n"
  + "if (open !== close) { console.error('SyntaxError: unbalanced braces'); process.exit(2); }\n"
  + "if (text.includes('BOOM') && text.includes('TRIGGER')) { console.error('RangeError: invalid state at offset ' + text.indexOf('BOOM')); process.exit(1); }\n";

function workspace(t, input) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oasis-minimize-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'parse.mjs'), PARSER);
  mkdirSync(path.join(root, 'data'));
  writeFileSync(path.join(root, 'data', 'big.txt'), input);
  return root;
}

function bigInput() {
  const lines = [];
  for (let index = 1; index <= 200; index += 1) {
    if (index === 10) lines.push('section {');
    else if (index === 150) lines.push('}');
    else if (index === 60) lines.push('value BOOM here');
    else if (index === 171) lines.push('flag TRIGGER');
    else lines.push('filler line ' + index + ' with some ordinary content');
  }
  return lines.join('\n') + '\n';
}

const command = process.execPath + ' parse.mjs data/big.txt';

test('ddmin finds the two units that matter and proves no single one can go', async () => {
  const units = Array.from({ length: 100 }, (_, index) => index + 1);
  let calls = 0;
  const found = await ddmin(units, async (subset) => { calls += 1; return subset.includes(37) && subset.includes(81); });
  assert.deepEqual(found.units, [37, 81]);
  assert.equal(found.minimal, true);
  assert.ok(calls < 100, 'far fewer tests than one per unit: ' + calls);
});

test('lines split and join back to the same text, with or without a final newline', () => {
  for (const text of ['a\nb\nc\n', 'a\nb\nc', '', '\n\n']) assert.equal(splitUnits(text, 'lines').join(''), text);
  assert.deepEqual(splitUnits('héllo', 'chars'), ['h', 'é', 'l', 'l', 'o']);
});

test('the key error line is masked, so the same failure at another offset still counts', () => {
  assert.equal(keyErrorLine('noise\nRangeError: invalid state at offset 1234\n    at foo (/tmp/x.js:1:2)'), keyErrorLine('RangeError: invalid state at offset 7'));
  assert.equal(keyErrorLine('all good'), '');
});

test('shrinks a 200-line input to the lines that cause the crash and restores the original', async (t) => {
  const root = workspace(t, bigInput());
  const file = path.join(root, 'data', 'big.txt');
  const past = new Date('2024-01-02T03:04:05Z');
  utimesSync(file, past, past);
  const before = readFileSync(file);
  const result = await runMinimizeRepro(root, { file: 'data/big.txt', command }, { autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.ok(result.lines.after <= 4, 'minimized to ' + result.lines.after + ' lines:\n' + result.minimized);
  assert.match(result.minimized, /BOOM/);
  assert.match(result.minimized, /TRIGGER/);
  assert.match(result.kept_failure, /exit 1 and "RangeError: invalid state at offset N"/);
  assert.equal(result.one_minimal, true);
  assert.equal(result.output, path.join('data', 'big.min.txt'));
  // The minimized input still fails the same way, not with the syntax error.
  const out = path.join(root, 'data', 'big.min.txt');
  assert.equal(readFileSync(out, 'utf8'), result.minimized);
  assert.throws(() => execFileSync(process.execPath, ['parse.mjs', 'data/big.min.txt'], { cwd: root, stdio: 'pipe' }), (error) => error.status === 1 && /RangeError/.test(String(error.stderr)));
  // The original is back, byte for byte, with its modification time.
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).mtimeMs, past.getTime());
  assert.equal(existsSync(path.join(root, '.oasis', 'minimize', 'journal.json')), false);
});

test('output_pattern decides what counts as the same failure', async (t) => {
  const root = workspace(t, bigInput());
  const result = await runMinimizeRepro(root, { file: 'data/big.txt', command, output_pattern: 'RangeError: invalid state', output: 'repro.txt' }, { autoApprove: true, env });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'repro.txt');
  assert.match(result.kept_failure, /RangeError: invalid state/);
  const miss = await runMinimizeRepro(root, { file: 'data/big.txt', command, output_pattern: 'TypeError' }, { autoApprove: true, env });
  assert.equal(miss.ok, false);
  assert.match(miss.message, /does not match output_pattern/);
});

test('character granularity shrinks inside a single line', async (t) => {
  const root = workspace(t, 'xxxxxxxxxx BOOM yyyyyyyyyy TRIGGER zzzzzzzzzz');
  const result = await runMinimizeRepro(root, { file: 'data/big.txt', command, granularity: 'chars' }, { autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.equal(result.minimized, 'BOOMTRIGGER');
});

test('a command that passes on the original has nothing to minimize', async (t) => {
  const root = workspace(t, 'nothing wrong here\n');
  const result = await runMinimizeRepro(root, { file: 'data/big.txt', command }, { autoApprove: true, env });
  assert.equal(result.ok, false);
  assert.match(result.message, /passes with the original/);
  assert.equal(readFileSync(path.join(root, 'data', 'big.txt'), 'utf8'), 'nothing wrong here\n');
});

test('one approval names the file and run budget; a no runs nothing', async (t) => {
  const root = workspace(t, bigInput());
  const prompts = [];
  const result = await runMinimizeRepro(root, { file: 'data/big.txt', command, max_runs: 40 }, { approval: async (text) => { prompts.push(text); return false; }, env });
  assert.equal(result.approved, false);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Shrink data\/big\.txt/);
  assert.match(prompts[0], /up to 40 times/);
  const high = [];
  await runMinimizeRepro(root, { file: 'data/big.txt', command }, { autoApprove: true, injectionHold: 'untrusted content', approval: async (text, flag) => { high.push(flag); return false; }, env });
  assert.deepEqual(high, [true]);
});

test('paths outside the workspace and an output over the original are refused', async (t) => {
  const root = workspace(t, bigInput());
  await assert.rejects(runMinimizeRepro(root, { file: '../etc/passwd', command }, { autoApprove: true, env }), /inside the workspace/);
  await assert.rejects(runMinimizeRepro(root, { file: 'data/big.txt', command, output: 'data/big.txt' }, { autoApprove: true, env }), /must differ/);
  await assert.rejects(runMinimizeRepro(root, { file: 'data/big.txt', command: 'node a | tee b' }, { autoApprove: true, env }), /simple command line/);
});

test('a journal left by a killed run puts the original back', async (t) => {
  const root = workspace(t, 'shrunk\n');
  mkdirSync(path.join(root, '.oasis', 'minimize'), { recursive: true });
  writeFileSync(path.join(root, '.oasis', 'minimize', 'journal.json'), JSON.stringify({ version: 1, pid: 2 ** 22 + 12345, relative: path.join('data', 'big.txt'), content: Buffer.from('the original\n').toString('base64'), mtime: null }));
  assert.equal(await restorePendingMinimize(root), path.join('data', 'big.txt'));
  assert.equal(readFileSync(path.join(root, 'data', 'big.txt'), 'utf8'), 'the original\n');
  assert.equal(existsSync(path.join(root, '.oasis', 'minimize', 'journal.json')), false);
});

test('minimize_repro is a registered tool that runs through executeTool', async (t) => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'minimize_repro'));
  const root = workspace(t, 'a\nBOOM\nb\nTRIGGER\nc\n');
  const result = await executeTool('minimize_repro', { file: 'data/big.txt', command }, { root, autoApprove: true, env });
  assert.equal(result.minimized, 'BOOM\nTRIGGER\n');
});

test('minimize_repro refuses secrets, protected config and outputs through symlinks', async (t) => {
  const root = workspace(t, bigInput());
  const outside = mkdtempSync(path.join(os.tmpdir(), 'oasis-minimize-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live-secret\n');
  mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(path.join(outside, 'escape.txt'), path.join(root, 'data', 'dangling.min.txt'));
  symlinkSync(outside, path.join(root, 'outdir'));
  const run = (args) => runMinimizeRepro(root, { command, ...args }, { autoApprove: true, env: { ...process.env, OASIS_ALLOW_CONFIG_EDITS: '' } });
  await assert.rejects(run({ file: '.env' }), /secret/);
  await assert.rejects(run({ file: 'data/big.txt', output: '.env.local' }), /secret/);
  await assert.rejects(run({ file: '.git/hooks/pre-commit' }), /protected configuration/);
  await assert.rejects(run({ file: 'data/big.txt', output: '.git/hooks/post-checkout' }), /protected configuration/);
  await assert.rejects(run({ file: 'data/big.txt', output: 'data/dangling.min.txt' }), /symlink/);
  await assert.rejects(run({ file: 'data/big.txt', output: 'outdir/min.txt' }), /outside the workspace/);
  assert.equal(existsSync(path.join(outside, 'escape.txt')), false);
  assert.equal(existsSync(path.join(outside, 'min.txt')), false);
  assert.equal(readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), '#!/bin/sh\nexit 0\n');
});
