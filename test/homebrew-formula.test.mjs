import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FORMULA_PATH, renderFormula } from '../scripts/homebrew-formula.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const A = 'a'.repeat(64);

test('the CLI formula installs the tagged source with npm and matches its generator', () => {
  const formula = renderFormula('1.2.0', A);
  assert.match(formula, /class OasisCli < Formula/);
  assert.match(formula, /archive\/refs\/tags\/v1\.2\.0\.tar\.gz/);
  assert.match(formula, /depends_on "node"/);
  assert.match(formula, /std_npm_args/);
  assert.match(formula, /OASIS #\{version\}/);
  assert.throws(() => renderFormula('1.2.0', 'nope'), /source-sha/);
  assert.throws(() => renderFormula('1.3.0-rc.1', A), /stable/);
  const committed = fs.readFileSync(FORMULA_PATH, 'utf8');
  const version = committed.match(/tags\/v(\d+\.\d+\.\d+)\.tar\.gz/)[1];
  const sha = committed.match(/sha256 "([0-9a-f]{64})"/)[1];
  assert.equal(committed, renderFormula(version, sha), 'regenerate with node scripts/homebrew-formula.mjs');
  assert.equal(pkg.bin.oasis, './src/oasis.mjs', 'the formula links the oasis binary');
});

test('the release workflow refreshes the formula only for stable releases', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Refresh the Homebrew formula on main'));
  assert.match(step, /outputs\.prerelease == 'false'/);
  assert.match(step, /node scripts\/homebrew-formula\.mjs --version "\$RELEASE_VERSION" --source-sha "\$source_sha"/);
  assert.match(step, /git add Formula\/oasis-cli\.rb/);
  assert.doesNotMatch(workflow, /electron|desktop|Casks/i);
});
