import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalModelPassthrough } from '../src/eval.mjs';

test('evalModelPassthrough routes --model to the external agent or to OASIS', () => {
  assert.deepEqual(evalModelPassthrough(['--aider', '--task', 't'], 'openai/qwen3', {}).args, ['--aider', '--task', 't', '--model', 'openai/qwen3']);
  const own = evalModelPassthrough(['--task', 't'], 'qwen3:8b', { OASIS_MODEL: 'old', KEEP: '1' });
  assert.deepEqual(own.args, ['--task', 't']);
  assert.deepEqual(own.env, { OASIS_MODEL: 'qwen3:8b', KEEP: '1' });
  const untouched = { A: '1' };
  assert.equal(evalModelPassthrough(['--codex'], null, untouched).env, untouched);
  assert.deepEqual(evalModelPassthrough(['--codex', '--model', 'x'], 'y', {}).args, ['--codex', '--model', 'x']);
});

test('oasis eval --aider --model reaches Aider and the report names that model', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-model-'));
  try {
    const record = path.join(dir, 'args.json');
    const bin = path.join(dir, 'fake-aider');
    await writeFile(bin, '#!' + process.execPath + '\n' +
      "const fs = require('node:fs'); const args = process.argv.slice(2);\n" +
      'fs.writeFileSync(' + JSON.stringify(record) + ', JSON.stringify(args));\n' +
      "const i = args.indexOf('--model'); console.log('Main model: ' + (i >= 0 ? args[i + 1] : 'gpt-4o') + ' with whole edit format');\n" +
      "console.log('Tokens: 10 sent, 5 received.');\n");
    await chmod(bin, 0o755);
    const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
    const env = { ...process.env, OASIS_AIDER_BIN: bin, OASIS_EVAL_RESULTS_DIR: path.join(dir, 'results'), OASIS_CONFIG_DIR: path.join(dir, 'cfg'), HOME: dir, OASIS_NO_UPDATE_CHECK: '1' };
    const result = spawnSync(process.execPath, [cli, 'eval', '--aider', '--model', 'openai/qwen3-4b-2507', '--task', 'bounded-pagination', '--trials', '1', '--timeout-seconds', '60', '--yes'], { env, encoding: 'utf8', timeout: 120000 });
    const args = JSON.parse(await readFile(record, 'utf8'));
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'openai/qwen3-4b-2507'], result.stderr);
    const reportPath = /result: (\S+\.json)/.exec(result.stdout)[1];
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.provider.model, 'openai/qwen3-4b-2507');
    assert.match(report.label, /openai\/qwen3-4b-2507/);
    assert.equal(report.results[0].model, 'openai/qwen3-4b-2507');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('oasis eval --task accepts a comma-separated list and rejects unknown IDs', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-tasks-'));
  try {
    const bin = path.join(dir, 'fake-aider');
    await writeFile(bin, '#!' + process.execPath + '\nconsole.log("Tokens: 1 sent, 1 received.");\n');
    await chmod(bin, 0o755);
    const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
    const env = { ...process.env, OASIS_AIDER_BIN: bin, OASIS_EVAL_RESULTS_DIR: path.join(dir, 'results'), OASIS_CONFIG_DIR: path.join(dir, 'cfg'), HOME: dir, OASIS_NO_UPDATE_CHECK: '1' };
    const run = (tasks) => spawnSync(process.execPath, [cli, 'eval', '--aider', '--task', tasks, '--trials', '1', '--timeout-seconds', '60', '--yes'], { env, encoding: 'utf8', timeout: 120000 });
    const ok = run('bounded-pagination,clamp-integer');
    const report = JSON.parse(await readFile(/result: (\S+\.json)/.exec(ok.stdout)[1], 'utf8'));
    assert.deepEqual([...new Set(report.results.map((row) => row.taskId))].sort(), ['bounded-pagination', 'clamp-integer']);
    const bad = run('clamp-integer,no-such-task');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr + bad.stdout, /no-such-task/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
