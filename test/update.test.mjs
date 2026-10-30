import test from 'node:test';
import assert from 'node:assert/strict';
import { latestReleaseCommit, installedVersion, updatePlan, describeUpdate, INSTALL_SPEC } from '../src/update.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('latestReleaseCommit resolves the latest stable tag to its exact commit', async () => {
  const urls = [];
  const payloads = [
    { tag_name: 'v0.4.0', name: 'OASIS 0.4.0', draft: false, prerelease: false, published_at: '2026-10-30T00:00:00Z' },
    { sha: SHA_B }
  ];
  const latest = await latestReleaseCommit({ fetch: async (url) => { urls.push(url); return { ok: true, json: async () => payloads.shift() }; } });
  assert.deepEqual(urls, ['https://api.github.com/repos/FAHTHIZ/oasis/releases/latest','https://api.github.com/repos/FAHTHIZ/oasis/commits/v0.4.0']);
  assert.deepEqual(latest, { sha: SHA_B, tag: 'v0.4.0', message: 'OASIS 0.4.0', date: '2026-10-30T00:00:00Z' });
});

test('latestReleaseCommit rejects API failures, prereleases, malformed tags and invalid commit ids', async () => {
  await assert.rejects(latestReleaseCommit({ fetch: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  await assert.rejects(latestReleaseCommit({ fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.5.0-rc.1' }) }) }), /valid latest stable/);
  let call = 0;
  await assert.rejects(latestReleaseCommit({ fetch: async () => {
    call++;
    return call === 1
      ? { ok: true, json: async () => ({ tag_name: 'v0.5.0' }) }
      : { ok: true, json: async () => ({ sha: 'bad' }) };
  } }), /valid commit id/);
});

test('archive installs read the immutable commit SHA from npm metadata', async () => {
  const installed = await installedVersion('/archive-install', {
    exec: async () => JSON.stringify({ dependencies: { 'oasis-oss': { resolved: INSTALL_SPEC + SHA_A + '.tar.gz' } } })
  });
  assert.deepEqual(installed, { kind: 'npm', commit: SHA_A, root: '/archive-install' });
});

test('npm updates use the exact release archive and preserve custom prefixes', async () => {
  const installed = await installedVersion('/npm-install', { exec: async () => JSON.stringify({ dependencies: { 'oasis-oss': { resolved: 'git+ssh://git@github.com/FAHTHIZ/oasis.git#' + SHA_A } } }) });
  const latest = { sha: SHA_B, tag: 'v0.4.0', message: 'OASIS 0.4.0', date: '2026-10-30T00:00:00Z' };
  assert.deepEqual(updatePlan(installed, latest).steps, [{ command: 'npm', args: ['install', '-g', INSTALL_SPEC + SHA_B + '.tar.gz'] }]);
  assert.deepEqual(updatePlan({ ...installed, npmPrefix: '/prefix' }, latest).steps[0].args, ['install', '-g', '--prefix', '/prefix', INSTALL_SPEC + SHA_B + '.tar.gz']);
  assert.match(describeUpdate(installed, latest, updatePlan(installed, latest)), /Latest stable release: v0\.4\.0/);
  assert.equal(updatePlan(installed, { sha: SHA_A, tag: 'v0.3.0' }).upToDate, true);
});

test('git checkouts fetch the release tag then detach at its resolved commit', () => {
  const latest = { sha: SHA_B, tag: 'v0.4.0' };
  assert.deepEqual(updatePlan({ kind: 'git', commit: SHA_A, root: '/r' }, latest), { upToDate: false, steps: [
    { command: 'git', args: ['-C', '/r', 'fetch', '--no-tags', 'origin', 'refs/tags/v0.4.0'] },
    { command: 'git', args: ['-C', '/r', 'checkout', '--detach', SHA_B] }
  ] });
  assert.match(updatePlan({ kind: 'git', commit: SHA_A, dirty: true, root: '/r' }, latest).blocked, /uncommitted/);
});
