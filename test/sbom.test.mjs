import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSbom, checkInstalled, integrityToHashes, purlFor, serializeSbom } from '../scripts/sbom.mjs';

const pkg = { name: 'demo-app', version: '1.2.3', license: 'Apache-2.0', dependencies: { left: '^1.0.0', '@scope/right': '2.0.0' }, optionalDependencies: { native: '1.0.0' }, devDependencies: { tester: '9.0.0' } };
const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
const lock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo-app', version: '1.2.3', dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies, devDependencies: pkg.devDependencies },
    'node_modules/left': { version: '1.4.0', resolved: 'https://registry.npmjs.org/left/-/left-1.4.0.tgz', integrity, license: 'MIT', dependencies: { shared: '^1.0.0' } },
    'node_modules/@scope/right': { version: '2.0.0', license: '(MIT OR Apache-2.0)', dependencies: { shared: '^2.0.0' } },
    'node_modules/@scope/right/node_modules/shared': { version: '2.1.0', license: 'ISC' },
    'node_modules/shared': { version: '1.0.5', license: 'ISC' },
    'node_modules/native': { version: '1.0.0', optional: true, license: 'SEE LICENSE IN LICENSE' },
    'node_modules/tester': { version: '9.0.0', dev: true }
  }
};

test('purls percent-encode the scope and hashes come from lockfile integrity', () => {
  assert.equal(purlFor('@scope/right', '2.0.0'), 'pkg:npm/%40scope/right@2.0.0');
  assert.equal(purlFor('left', '1.4.0'), 'pkg:npm/left@1.4.0');
  assert.deepEqual(integrityToHashes(integrity), [{ alg: 'SHA-512', content: '07'.repeat(64) }]);
  assert.deepEqual(integrityToHashes('md5-xyz'), []);
});

test('the SBOM lists the production closure, marks optional packages and leaves dev ones out', () => {
  const sbom = buildSbom({ pkg, lock, timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.6');
  const refs = sbom.components.map((component) => component['bom-ref']);
  assert.deepEqual(refs, [...refs].sort());
  assert.ok(refs.includes('pkg:npm/shared@1.0.5') && refs.includes('pkg:npm/shared@2.1.0'), 'both copies of a nested dependency are listed');
  assert.ok(!refs.some((ref) => ref.includes('tester')), 'dev-only packages are not shipped');
  const native = sbom.components.find((component) => component.name === 'native');
  assert.equal(native.scope, 'optional');
  assert.deepEqual(native.licenses, [{ license: { name: 'SEE LICENSE IN LICENSE' } }]);
  const right = sbom.components.find((component) => component.name === 'right');
  assert.equal(right.group, '@scope');
  assert.deepEqual(right.licenses, [{ expression: '(MIT OR Apache-2.0)' }]);
  const left = sbom.components.find((component) => component.name === 'left');
  assert.equal(left.externalReferences[0].url, 'https://registry.npmjs.org/left/-/left-1.4.0.tgz');
  assert.equal(left.hashes[0].alg, 'SHA-512');
  // Node's resolution: @scope/right gets its own nested shared@2.1.0.
  const edges = Object.fromEntries(sbom.dependencies.map((item) => [item.ref, item.dependsOn]));
  assert.deepEqual(edges['pkg:npm/%40scope/right@2.0.0'], ['pkg:npm/shared@2.1.0']);
  assert.deepEqual(edges['pkg:npm/left@1.4.0'], ['pkg:npm/shared@1.0.5']);
  assert.deepEqual(edges['pkg:npm/demo-app@1.2.3'], ['pkg:npm/%40scope/right@2.0.0', 'pkg:npm/left@1.4.0', 'pkg:npm/native@1.0.0']);
  assert.ok(buildSbom({ pkg, lock, includeDev: true, timestamp: 'x' }).components.some((component) => component.name === 'tester'));
});

test('the same lockfile and SOURCE_DATE_EPOCH give a byte-identical SBOM', () => {
  const env = { SOURCE_DATE_EPOCH: '1700000000' };
  const first = serializeSbom(buildSbom({ pkg, lock, env }));
  const second = serializeSbom(buildSbom({ pkg, lock: JSON.parse(JSON.stringify(lock)), env }));
  assert.equal(first, second);
  assert.match(first, /"timestamp": "2023-11-14T22:13:20.000Z"/);
  const serial = JSON.parse(first).serialNumber;
  assert.match(serial, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const changed = JSON.parse(JSON.stringify(lock));
  changed.packages['node_modules/left'].version = '1.4.1';
  assert.notEqual(JSON.parse(serializeSbom(buildSbom({ pkg, lock: changed, env }))).serialNumber, serial);
});

function install(root, entries) {
  const hidden = { lockfileVersion: 3, packages: {} };
  for (const [key, entry] of Object.entries(entries)) {
    mkdirSync(path.join(root, key), { recursive: true });
    writeFileSync(path.join(root, key, 'package.json'), JSON.stringify({ name: key.split('node_modules/').pop(), version: entry.version }));
    hidden.packages[key] = entry;
  }
  writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), JSON.stringify(hidden));
}

test('--check finds missing, different and unlisted installed packages', () => {
  const sbom = buildSbom({ pkg, lock, timestamp: 'x' });
  const good = mkdtempSync(path.join(tmpdir(), 'oasis-sbom-'));
  const installed = Object.fromEntries(Object.entries(lock.packages).filter(([key, entry]) => key && !entry.optional));
  install(good, installed);
  const ok = checkInstalled(sbom, good);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.checked, 4);

  const bad = mkdtempSync(path.join(tmpdir(), 'oasis-sbom-'));
  const tampered = { ...installed, 'node_modules/left': { version: '6.6.6' }, 'node_modules/evil': { version: '0.0.1' } };
  delete tampered['node_modules/shared'];
  install(bad, tampered);
  const result = checkInstalled(sbom, bad);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatched, ['left@6.6.6 (SBOM: 1.4.0)']);
  assert.deepEqual(result.unlisted, ['evil@0.0.1']);
  assert.ok(!result.missing.length, 'shared@2.1.0 is still installed under @scope/right');
});

test('the repository SBOM covers every production dependency in package.json', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const realPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const realLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const sbom = buildSbom({ pkg: realPkg, lock: realLock, timestamp: '2026-01-01T00:00:00.000Z' });
  const names = new Set(sbom.components.map((component) => (component.group ? component.group + '/' : '') + component.name));
  for (const name of Object.keys(realPkg.dependencies)) assert.ok(names.has(name), name + ' is missing from the SBOM');
  for (const component of sbom.components) if (component.scope === 'required') assert.ok(component.hashes && component.hashes.length, component.purl + ' has no hash');
});
