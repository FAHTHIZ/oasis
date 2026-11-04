#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
let runs = 5;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help' || arg === '-h') { process.stdout.write('Usage: npm run bench:startup -- [--runs 1-30]\n\nMeasures repeated launch time for the installed oasis --version command. This is not agent startup or task latency.\n'); process.exit(0); }
  if (arg === '--runs' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) runs = Number(process.argv[++i]); else throw new Error('Unknown or incomplete option: ' + arg);
}
if (!Number.isInteger(runs) || runs < 1 || runs > 30) throw new Error('--runs must be an integer from 1 to 30.');
const command = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'OASIS', 'oasis.cmd') : path.join(os.homedir(), '.local', 'bin', 'oasis');
const samples = []; let version = '';
for (let i = 0; i < runs; i++) {
  const started = performance.now(); const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' }); const elapsedMs = performance.now() - started;
  if (result.error) { process.stderr.write('Could not measure OASIS CLI launch: ' + result.error.message + '\n'); process.exit(1); }
  if (result.status !== 0) { process.stderr.write('OASIS --version failed with exit code ' + result.status + '\n' + (result.stderr || '')); process.exit(result.status || 1); }
  version = (result.stdout || '').trim().split(/\r?\n/)[0]; samples.push(Number(elapsedMs.toFixed(1)));
}
const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
const median = sorted.length % 2 ? sorted[middle] : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(1));
process.stdout.write('OASIS version: ' + version + '\n');
process.stdout.write('Installed CLI command: ' + command + '\n');
process.stdout.write('Observed launch-time samples for --version (ms): ' + samples.join(', ') + '\n');
process.stdout.write('Median: ' + median.toFixed(1) + ' ms · min: ' + sorted[0].toFixed(1) + ' ms · max: ' + sorted[sorted.length - 1].toFixed(1) + ' ms\n');
process.stdout.write('Runtime: ' + process.version + ' · ' + process.platform + '-' + process.arch + '\n');
process.stdout.write('Note: samples are sequential and share the host cache state; this is not a controlled cold-start or model-request latency measurement.\n');