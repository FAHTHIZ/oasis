import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const command = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'OASIS', 'oasis.cmd')
  : path.join(os.homedir(), '.local', 'bin', 'oasis');
const started = performance.now();
const result = spawnSync(command, ['--version'], {
  encoding: 'utf8',
  windowsHide: true,
  shell: process.platform === 'win32'
});
const elapsed = performance.now() - started;
if (result.error) {
  process.stderr.write('Could not measure OASIS startup: ' + result.error.message + '\n');
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.stderr.write('OASIS --version failed with exit code ' + result.status + '\n');
  process.stderr.write(result.stderr || '');
  process.exitCode = result.status || 1;
} else {
  process.stdout.write((result.stdout || '').trim() + '\n');
  process.stdout.write('Measured cold CLI startup for --version: ' + elapsed.toFixed(1) + ' ms\n');
}
