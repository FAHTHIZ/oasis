import test from 'node:test';
import assert from 'node:assert/strict';
import { latestMainCommit, installedVersion, updatePlan, describeUpdate, INSTALL_SPEC } from '../src/update.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('latestMainCommit reads the GitHub commit API', async () => {
  const latest = await latestMainCommit({ fetch: async (url) => {
    assert.match(url, /repos\/FAHTHIZ\/oasis\/commits\/main$/);
    return { ok: true, json: async () => ({ sha: SHA_B, commit: { message: 'Add worktrees\n\nbody', committer: { date: '2026-10-28T00:00:00Z' } } }) };
  } });
  assert.deepEqual(latest, { sha: SHA_B, message: 'Add worktrees', date: '2026-10-28T00:00:00Z' });
  await assert.rejects(latestMainCommit({ fetch: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});

test('npm installs read the commit npm recorded; plans pick npm or git', async () => {
  const exec = async (cmd) => {
    if (cmd === 'npm') return JSON.stringify({ dependencies: { 'oasis-oss': { resolved: 'git+ssh://git@github.com/FAHTHIZ/oasis.git#' + SHA_A } } });
    throw new Error('no');
  };
  const installed = await installedVersion('/nonexistent-oasis-root', { exec });
  assert.deepEqual(installed, { kind: 'npm', commit: SHA_A, root: '/nonexistent-oasis-root' });
  const plan = updatePlan(installed, { sha: SHA_B });
  assert.deepEqual(plan, { upToDate: false, command: 'npm', args: ['install', '-g', INSTALL_SPEC] });
  assert.match(describeUpdate(installed, { sha: SHA_B, message: 'm' }, plan), /aaaaaaa[\s\S]*bbbbbbb - m[\s\S]*npm install -g/);
  assert.equal(updatePlan(installed, { sha: SHA_A }).upToDate, true);
  const prefixed = await installedVersion('/custom/prefix/lib/node_modules/oasis-oss', {
    npmPrefix: '/custom/prefix',
    exec: async (cmd, args) => {
      assert.deepEqual(args, ['ls', '-g', '--prefix', '/custom/prefix', 'oasis-oss', '--json', '--long']);
      return JSON.stringify({ dependencies: { 'oasis-oss': { resolved: 'git+https://github.com/FAHTHIZ/oasis.git#' + SHA_A } } });
    }
  });
  assert.equal(prefixed.npmPrefix, '/custom/prefix');
  assert.deepEqual(updatePlan(prefixed, { sha: SHA_B }).args, ['install', '-g', '--prefix', '/custom/prefix', INSTALL_SPEC]);
  assert.deepEqual(updatePlan({ kind: 'git', commit: SHA_A, root: '/r' }, { sha: SHA_B }).args, ['-C', '/r', 'pull', '--ff-only', 'origin', 'main']);
  assert.match(updatePlan({ kind: 'git', commit: SHA_A, dirty: true, root: '/r' }, { sha: SHA_B }).blocked, /uncommitted/);
});
