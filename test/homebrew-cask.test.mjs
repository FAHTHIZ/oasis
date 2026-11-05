import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CASK_PATH, FORMULA_PATH, dmgChecksums, renderCask, renderFormula } from '../scripts/homebrew-cask.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('dmg checksums are read for the requested version only', () => {
  const sums = [A + '  ./OASIS-1.2.0-arm64.dmg', B + '  ./OASIS-1.2.0-x64.dmg', 'c'.repeat(64) + '  ./OASIS-1.2.0-x64.dmg.blockmap',
    'd'.repeat(64) + '  ./OASIS-1.1.0-arm64.dmg', 'e'.repeat(64) + ' *OASIS-1.2.0-x64.exe'].join('\n');
  assert.deepEqual(dmgChecksums(sums, '1.2.0'), { arm64: A, x64: B });
  assert.deepEqual(dmgChecksums(sums, '9.9.9'), {});
});

test('the cask pins both architectures and refuses incomplete or prerelease input', () => {
  const cask = renderCask('1.2.0', { arm64: A, x64: B });
  assert.match(cask, /version "1\.2\.0"/);
  assert.match(cask, new RegExp('arm:\\s+"' + A + '"'));
  assert.match(cask, new RegExp('intel: "' + B + '"'));
  assert.match(cask, /releases\/download\/v#\{version\}\/OASIS-#\{version\}-#\{arch\}\.dmg/);
  assert.match(cask, /auto_updates true/);
  assert.match(cask, /app "OASIS\.app"/);
  assert.throws(() => renderCask('1.2.0', { arm64: A }), /x64\.dmg/);
  assert.throws(() => renderCask('1.3.0-rc.1', { arm64: A, x64: B }), /stable/);
});

test('the committed cask matches its generator and names a real release artifact', () => {
  const committed = fs.readFileSync(CASK_PATH, 'utf8');
  const version = committed.match(/version "([^"]+)"/)[1];
  const arm64 = committed.match(/arm:\s+"([0-9a-f]{64})"/)[1];
  const x64 = committed.match(/intel: "([0-9a-f]{64})"/)[1];
  assert.equal(committed, renderCask(version, { arm64, x64 }), 'regenerate with node scripts/homebrew-cask.mjs');
  // The cask may trail package.json between a version bump and its release, never lead it.
  const parts = (v) => v.split('.').map(Number);
  const [a, b] = [parts(version), parts(pkg.version.split('-')[0])];
  assert.ok(a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] <= b[2]))), 'cask ' + version + ' is ahead of package ' + pkg.version);
  assert.equal(pkg.build.productName, 'OASIS', 'the cask installs OASIS.app');
});

test('the release workflow refreshes the cask only for stable releases', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/desktop-build.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Refresh the Homebrew cask on main'));
  assert.match(step, /outputs\.prerelease == 'false'/);
  assert.match(step, /node scripts\/homebrew-cask\.mjs --version "\$RELEASE_VERSION" --sums \.\.\/release-assets\/SHA256SUMS --source-sha "\$source_sha"/);
  assert.match(step, /archive\/refs\/tags\/\$\{RELEASE_TAG\}\.tar\.gz/);
  assert.match(step, /git add Casks\/oasis\.rb Formula\/oasis-cli\.rb/);
});

test('the CLI formula installs the tagged source with npm and matches its generator', () => {
  const formula = renderFormula('1.2.0', A);
  assert.match(formula, /class OasisCli < Formula/);
  assert.match(formula, /archive\/refs\/tags\/v1\.2\.0\.tar\.gz/);
  assert.match(formula, /depends_on "node"/);
  assert.match(formula, /std_npm_args/);
  assert.match(formula, /OASIS #\{version\}/);
  assert.throws(() => renderFormula('1.2.0', 'nope'), /source-sha/);
  const committed = fs.readFileSync(FORMULA_PATH, 'utf8');
  const version = committed.match(/tags\/v(\d+\.\d+\.\d+)\.tar\.gz/)[1];
  const sha = committed.match(/sha256 "([0-9a-f]{64})"/)[1];
  assert.equal(committed, renderFormula(version, sha), 'regenerate with node scripts/homebrew-cask.mjs');
  assert.equal(version, fs.readFileSync(CASK_PATH, 'utf8').match(/version "([^"]+)"/)[1], 'cask and formula track the same release');
  assert.equal(pkg.bin.oasis, './src/cli.mjs', 'the formula links the oasis binary');
});
