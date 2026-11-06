import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const entry = new URL('../src/oasis.mjs', import.meta.url);
const cli = new URL('../src/cli.mjs', import.meta.url);
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const run = (file, args) => execFileSync(process.execPath, [file.pathname, ...args], { encoding: 'utf8', env: { ...process.env, OASIS_NO_UPDATE_CHECK: '1' } });

test('oasis --version and -v answer from the entry point with the same text as the full CLI', () => {
  for (const flag of ['--version', '-v']) {
    assert.equal(run(entry, [flag]), 'OASIS ' + version + '\n');
    assert.equal(run(cli, [flag]), 'OASIS ' + version + '\n');
  }
});
