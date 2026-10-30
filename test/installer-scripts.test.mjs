import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(ROOT, file), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('published installer checksums match the exact checked-in scripts', async () => {
  const [readme, shell, powershell] = await Promise.all([read('README.md'), read('scripts/install.sh'), read('scripts/install.ps1')]);
  assert.equal(readme.match(/expected=([a-f0-9]{64})/)?.[1], sha256(shell));
  assert.equal(readme.match(/\$expected='([a-f0-9]{64})'/)?.[1], sha256(powershell));
  assert.equal(readme.match(/Published installer SHA-256:\s*`([a-f0-9]{64})`/)?.[1], sha256(shell));
  assert.equal(readme.match(/Published Windows installer SHA-256:\s*`([a-f0-9]{64})`/)?.[1], sha256(powershell));
  assert.match(readme, /mktemp.*oasis-install/);
  assert.match(readme, /NewGuid\(\)\.ToString\('N'\)/);
});

test('installers resolve the latest stable release to an immutable commit SHA', async () => {
  const [readme, shell, powershell, termux, install] = await Promise.all([read('README.md'), read('scripts/install.sh'), read('scripts/install.ps1'), read('docs/TERMUX.md'), read('docs/INSTALL.md')]);
  for (const script of [shell, powershell]) {
    assert.match(script, /api\.github\.com\/repos\/FAHTHIZ\/oasis/);
    assert.match(script, /releases\/latest/);
    assert.match(script, /commits\//);
    assert.match(script, /archive\/\$?(OASIS_COMMIT|ReleaseCommit)/);
    assert.match(script, /Latest stable release/);
    assert.doesNotMatch(script, /d3a2156924e7fe6bfd8f7bad5b49b8531f740a0a|v0\.3\.0/);
  }
  assert.match(readme, /latest stable GitHub release/i);
  assert.match(termux, /latest stable GitHub release/i);
  assert.match(install, /latest stable GitHub release/i);
  assert.match(termux, /official.*Termux/i);
  assert.match(termux, /Android is not yet a fully verified support target/i);
  assert.match(install, /TERMUX\.md/);
});


test('shell release resolver is valid JavaScript and falls back from API rate limits', async () => {
  const shell = await read('scripts/install.sh');
  const embedded = shell.match(/node --input-type=module -e '\n([\s\S]*?)\n'\n}/);
  assert.ok(embedded, 'installer must contain its embedded Node release resolver');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const html = '<a data-hovercard-type="commit" data-hovercard-url="/FAHTHIZ/oasis/commit/' + sha +
    '/hovercard" href="https://github.com/FAHTHIZ/oasis/commit/' + sha + '"><code>0123456</code></a>';
  const harness = [
    'globalThis.fetch = async (url) => {',
    '  if (String(url).startsWith("https://api.github.com/")) return { ok: false, status: 403, json: async () => ({}) };',
    '  if (String(url) === "https://github.com/FAHTHIZ/oasis/releases/latest") return { ok: true, status: 200, url: "https://github.com/FAHTHIZ/oasis/releases/tag/v9.8.7", text: async () => ' + JSON.stringify(html) + ' };',
    '  throw new Error("Unexpected URL: " + url);',
    '};',
    embedded[1]
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'v9.8.7\n' + sha);
  assert.match(result.stderr, /GitHub API unavailable/);
});

test('shell release resolver falls back to the public Atom feed when release HTML omits the commit SHA', async () => {
  const shell = await read('scripts/install.sh');
  const embedded = shell.match(/node --input-type=module -e '\n([\s\S]*?)\n'\n}/);
  assert.ok(embedded, 'installer must contain its embedded Node release resolver');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const atom = '<?xml version="1.0"?><feed><entry><id>tag:github.com,2008:Grit::Commit/' + sha + '</id></entry></feed>';
  const harness = [
    'globalThis.fetch = async (url) => {',
    '  const target = String(url);',
    '  if (target.startsWith("https://api.github.com/")) return { ok: false, status: 403, json: async () => ({}) };',
    '  if (target === "https://github.com/FAHTHIZ/oasis/releases/latest") return { ok: true, status: 200, url: "https://github.com/FAHTHIZ/oasis/releases/tag/v9.8.7", text: async () => "<html>no commit SHA here</html>" };',
    '  if (target === "https://github.com/FAHTHIZ/oasis/commits/v9.8.7.atom") return { ok: true, status: 200, text: async () => ' + JSON.stringify(atom) + ' };',
    '  throw new Error("Unexpected URL: " + target);',
    '};',
    embedded[1]
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'v9.8.7\n' + sha);
  assert.match(result.stderr, /GitHub API unavailable/);
});

test('Windows installer has the same public-page and Atom-feed fallbacks for API rate limits', async () => {
  const powershell = await read('scripts/install.ps1');
  assert.match(powershell, /trying the official public release page/i);
  assert.match(powershell, /data-hovercard-type="commit"/);
  assert.match(powershell, /commits\/\$encodedTag\.atom/i);
  assert.ok(powershell.includes("releases/latest"));
});
