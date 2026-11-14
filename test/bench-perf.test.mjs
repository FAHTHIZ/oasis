import test from 'node:test';
import assert from 'node:assert/strict';
import { installedCommand, parseArgs, sampledRun, summarize } from '../scripts/bench-perf.mjs';

test('bench:perf options are bounded and unknown flags are refused', () => {
  assert.deepEqual(parseArgs([]), { runs: 7, json: '', compare: false, installed: false });
  assert.equal(parseArgs(['--installed']).installed, true);
  assert.equal(parseArgs(['--compare']).compare, true);
  assert.equal(parseArgs(['--runs', '3']).runs, 3);
  assert.throws(() => parseArgs(['--runs', '0']), /1-50/);
  assert.throws(() => parseArgs(['--fast']), /Unknown/);
});

test('bench:perf summaries use nearest-rank percentiles and skip missing samples', () => {
  assert.deepEqual(summarize([30, 10, 20, NaN]), { runs: 3, median: 20, p90: 30, min: 10, max: 30 });
  assert.equal(summarize([]), null);
});

test('bench:perf sampler sees the peak memory of the child and its subprocesses', { skip: process.platform !== 'linux' }, async () => {
  const grandchild = "const b = Buffer.alloc(80e6, 1); setTimeout(() => console.log(b[5]), 300)";
  const parent = `require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' })`;
  const run = await sampledRun(process.execPath, ['-e', parent]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /1/);
  assert.ok(run.processes >= 2, `expected the subprocess to be sampled, saw ${run.processes}`);
  assert.ok(run.largest > 80, `largest peak ${run.largest} MB should include the 80 MB buffer`);
  assert.ok(run.total >= run.largest);
  const missing = await sampledRun('/nonexistent-oasis-binary', []);
  assert.equal(missing.status, null);
  assert.ok(missing.error);
});

test('bench:perf --installed times the launcher the installers write', () => {
  assert.equal(installedCommand('linux', {}, '/home/u'), '/home/u/.local/bin/oasis');
  assert.match(installedCommand('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u'), /OASIS[\\/]oasis\.cmd$/);
});

test('every script a workflow runs exists in the repository', async () => {
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  const dir = new URL('../.github/workflows/', import.meta.url);
  const missing = [];
  for (const name of readdirSync(dir)) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    const roots = ['', ...[...text.matchAll(/working-directory:\s*([\w./-]+)/g)].map((m) => m[1].replace(/\/?$/, '/'))];
    for (const [, file] of text.matchAll(/\bnode\s+((?:scripts|bench|src|\.github\/scripts)\/[\w./-]+\.m?js)\b/g)) {
      if (!roots.some((root) => existsSync(new URL('../' + root + file, import.meta.url)))) missing.push(name + ': ' + file);
    }
  }
  assert.deepEqual(missing, []);
});
