#!/usr/bin/env node
// `npm test`: runs the suite with a private temporary directory and removes
// it afterwards. Many tests create scratch projects under os.tmpdir(); without
// this, every full run left a few hundred folders behind (about 1 GB, mostly
// heap snapshots from the /heapdump test).
//
//   npm test                         # every test/*.test.mjs
//   npm test -- test/web.test.mjs    # selected files (any node --test flags work)
//
// Set OASIS_KEEP_TEST_TMP=1 to keep the folder for debugging; its path is printed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const files = args.some((arg) => !arg.startsWith('-')) ? [] : ['test/*.test.mjs'];
const scratch = mkdtempSync(path.join(os.tmpdir(), 'oasis-test-run-'));
const keep = /^(?:1|true|yes)$/i.test(process.env.OASIS_KEEP_TEST_TMP || '');

const cleanup = () => {
  if (keep) { process.stderr.write('Test scratch folder kept: ' + scratch + '\n'); return; }
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
};

const child = spawn(process.execPath, ['--test', ...args, ...files], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(code === null ? (signal ? 1 : 0) : code);
});
