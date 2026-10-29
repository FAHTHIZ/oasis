import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const workspace = process.argv[2];
const result = spawnSync(process.execPath, ['--test'], {
  cwd: workspace,
  encoding: 'utf8',
  timeout: 120000,
  env: {
    ...process.env,
    OASIS_REQUIRE_READ_BEFORE_EDIT: '0'
  }
});
assert.equal(
  result.status,
  0,
  'Repository tests failed (status ' + result.status + '):\n' +
    String(result.stdout || '').slice(-6000) + '\n' +
    String(result.stderr || '').slice(-6000)
);
