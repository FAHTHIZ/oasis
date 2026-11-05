import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLatestRelease, githubApiHeaders, parseExpandedAssets, resolveTagCommit } from '../src/github-release.mjs';
import { checkForAppUpdate } from '../src/app-update.mjs';
import { latestReleaseCommit } from '../src/update.mjs';

const REPO = 'FAHTHIZ/oasis';
const SHA = '900c76f718066940b0895e1576d552e374b0faa3';
const ASSETS_HTML = [
  '<a href="/FAHTHIZ/oasis/releases/download/v1.1.0/OASIS-1.1.0-x64.exe" rel="nofollow">',
  '<a href="/FAHTHIZ/oasis/releases/download/v1.1.0/OASIS-1.1.0-x64.exe" rel="nofollow">',
  '<a href="/FAHTHIZ/oasis/releases/download/v1.1.0/OASIS-1.1.0-arm64.dmg">',
  '<a href="/FAHTHIZ/oasis/releases/download/v1.1.0/SHA256SUMS">',
  '<a href="/FAHTHIZ/oasis/archive/refs/tags/v1.1.0.zip">',
  '<a href="/evil/repo/releases/download/v1.1.0/OASIS-1.1.0-x64.exe">'
].join('\n');

function rateLimitedFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.startsWith('https://api.github.com/')) return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
    if (u === 'https://github.com/FAHTHIZ/oasis/releases/latest') {
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://github.com/FAHTHIZ/oasis/releases/tag/v1.1.0' } });
    }
    if (u === 'https://github.com/FAHTHIZ/oasis/releases/expanded_assets/v1.1.0') return new Response(ASSETS_HTML, { status: 200 });
    if (u === 'https://github.com/FAHTHIZ/oasis/commits/v1.1.0.atom') return new Response('<feed><entry><id>tag:github.com,2008:Grit::Commit/' + SHA + '</id></entry><entry><id>tag:github.com,2008:Grit::Commit/' + 'a'.repeat(40) + '</id></entry></feed>', { status: 200 });
    return new Response('nope', { status: 500 });
  };
}

test('githubApiHeaders adds a token only when one is configured', () => {
  assert.equal(githubApiHeaders({}).authorization, undefined);
  assert.equal(githubApiHeaders({ GH_TOKEN: 'ghp_' + 'x'.repeat(36) }).authorization, 'Bearer ghp_' + 'x'.repeat(36));
  assert.equal(githubApiHeaders({ GITHUB_TOKEN: 'bad token with spaces' }).authorization, undefined);
});

test('parseExpandedAssets keeps only this release\'s downloads, once each', () => {
  const assets = parseExpandedAssets(ASSETS_HTML, REPO, 'v1.1.0');
  assert.deepEqual(assets.map((a) => a.name), ['OASIS-1.1.0-x64.exe', 'OASIS-1.1.0-arm64.dmg', 'SHA256SUMS']);
  assert.equal(assets[0].browser_download_url, 'https://github.com/FAHTHIZ/oasis/releases/download/v1.1.0/OASIS-1.1.0-x64.exe');
});

test('a rate-limited API falls back to github.com for the release, assets and commit', async () => {
  const calls = [];
  const fetchImpl = rateLimitedFetch(calls);
  const release = await fetchLatestRelease(REPO, { fetchImpl, env: {} });
  assert.equal(release.tag_name, 'v1.1.0');
  assert.equal(release.source, 'web');
  assert.equal(release.assets.length, 3);
  assert.equal(await resolveTagCommit(REPO, 'v1.1.0', { fetchImpl, env: {} }), SHA);
  // Tokens never leave api.github.com.
  for (const call of calls.filter((c) => !c.url.startsWith('https://api.github.com/'))) assert.equal(call.init.headers.authorization, undefined);
});

test('app update check and oasis update both work while the API is rate limited', async () => {
  const fetchImpl = rateLimitedFetch([]);
  const result = await checkForAppUpdate({ currentVersion: '1.0.0', kind: 'nsis', arch: 'x64', fetchImpl, env: {} });
  assert.equal(result.available, true);
  assert.equal(result.latest.version, '1.1.0');
  assert.equal(result.asset.name, 'OASIS-1.1.0-x64.exe');
  assert.match(result.checksumsUrl, /SHA256SUMS$/);
  assert.equal(result.canInstall, true);
  const commit = await latestReleaseCommit({ fetch: fetchImpl, env: {} });
  assert.deepEqual({ sha: commit.sha, tag: commit.tag }, { sha: SHA, tag: 'v1.1.0' });
});

test('other API errors still fail clearly instead of guessing', async () => {
  const fetchImpl = async () => new Response('down', { status: 502 });
  await assert.rejects(fetchLatestRelease(REPO, { fetchImpl, env: {} }), /HTTP 502/);
  await assert.rejects(resolveTagCommit(REPO, 'v1.1.0', { fetchImpl, env: {} }), /HTTP 502/);
});

test('no releases yet is not an error', async () => {
  const fetchImpl = async (url) => String(url).startsWith('https://api.github.com/')
    ? new Response('{}', { status: 429 })
    : new Response(null, { status: 302, headers: { location: 'https://github.com/FAHTHIZ/oasis/releases' } });
  assert.equal(await fetchLatestRelease(REPO, { fetchImpl, env: {} }), null);
});
