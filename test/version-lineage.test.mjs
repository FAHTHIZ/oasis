import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalVersion, compareLineage, describeVersion, isRetiredVersion } from '../src/version-lineage.mjs';
import { compareVersions } from '../src/app-update.mjs';
import { updatePlan, describeUpdate } from '../src/update.mjs';

test('the retired 1.x numbers map onto 0.x by moving the major into the minor', () => {
  const published = { '1.0.0': '0.1.0', '1.1.0': '0.2.0', '1.1.1': '0.2.1', '1.2.0': '0.3.0', '1.3.0': '0.4.0', '1.4.0': '0.5.0', '1.5.0': '0.6.0', '1.6.0': '0.7.0', '1.7.0': '0.8.0', '1.7.1': '0.8.1', '1.7.2': '0.8.2', '1.8.0': '0.9.0' };
  for (const [old, now] of Object.entries(published)) assert.equal(canonicalVersion(old), now, old);
  assert.equal(canonicalVersion('v1.8.0'), 'v0.9.0');
  assert.equal(canonicalVersion('1.8.0-rc.1+abc'), '0.9.0-rc.1+abc');
  assert.equal(canonicalVersion('0.10.0'), '0.10.0');
  assert.equal(canonicalVersion('2.0.0'), '2.0.0');
  assert.equal(canonicalVersion('latest'), 'latest');
  assert.ok(isRetiredVersion('v1.8.0'));
  assert.ok(!isRetiredVersion('0.10.0'));
  assert.equal(describeVersion('1.8.0'), '1.8.0 (now numbered 0.9.0)');
  assert.equal(describeVersion('0.10.0'), '0.10.0');
});

test('an install still on 1.8.0 is older than 0.10.0 and newer than nothing after it', () => {
  assert.equal(compareLineage('1.8.0', '0.10.0'), -1);
  assert.equal(compareLineage('v0.10.0', 'v1.8.0'), 1);
  assert.equal(compareLineage('1.8.0', '0.9.0'), 0);
  assert.equal(compareLineage('0.99.0', '2.0.0'), -1, 'the line after 0.x is 2.0.0');
  assert.equal(compareLineage('nope', '0.1.0'), null);
  assert.equal(compareVersions('0.10.0', '1.8.0'), 1, 'the desktop update check offers 0.10.0 to a 1.8.0 app');
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1, 'order inside the old line is kept');
});

test('oasis update offers 0.10.0 to an npm install of 1.8.0 instead of calling it a downgrade', () => {
  const installed = { kind: 'npm', commit: '', version: '1.8.0', root: '/npm' };
  const latest = { tag: 'v0.10.0', sha: 'a'.repeat(40), tarball: { tarball: { name: 'oasis-oss-0.10.0.tgz' } } };
  const plan = updatePlan(installed, latest);
  assert.equal(plan.upToDate, false);
  assert.ok(!plan.newer);
  assert.match(describeUpdate(installed, latest, plan), /v1\.8\.0 \(now numbered 0\.9\.0\)/);
  assert.equal(updatePlan({ ...installed, version: '0.11.0' }, latest).newer, true, 'a real later version is still left alone');
});

test('the package is on the 0.x line and its release tag matches', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version.split('.')[0], '0');
  assert.equal(pkg.oasisRelease.stableTag, 'v' + pkg.version);
});

test('the web app shows the package version, not a stale constant', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const app = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');
  assert.equal(/const APP_VERSION = '([^']+)'/.exec(app)[1], pkg.version, 'update APP_VERSION in app/main.mjs with each release');
  assert.match(readFileSync(new URL('../src/web.mjs', import.meta.url), 'utf8'), /version: oasisVersion\(\)/, 'the runtime status reports its version');
});
