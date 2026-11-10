import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { desktopPackageJson } from '../desktop/scripts/build.mjs';

const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const desktopPackage = JSON.parse(await readFile(new URL('../desktop/package.json', import.meta.url), 'utf8'));
const desktopMain = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const webRuntime = await readFile(new URL('../src/web.mjs', import.meta.url), 'utf8');
const desktopSecrets = await readFile(new URL('../desktop/secure-secrets.mjs', import.meta.url), 'utf8');

test('the npm CLI package stays free of Electron; desktop tooling is pinned in desktop/', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    assert.ok(!rootPackage[field] || !rootPackage[field].electron, 'electron must not be a root ' + field);
    assert.ok(!rootPackage[field] || !rootPackage[field]['electron-builder']);
  }
  assert.ok(!rootPackage.files.includes('desktop/'), 'the CLI tarball does not ship the desktop shell');
  assert.match(desktopPackage.devDependencies.electron, /^\d+\.\d+\.\d+$/, 'Electron is pinned exactly');
  assert.match(desktopPackage.devDependencies['electron-builder'], /^\d+\.\d+\.\d+$/);
  assert.equal(desktopPackage.private, true);
});

test('the staged app reuses the root runtime and dependencies and builds every platform installer', () => {
  const staged = desktopPackageJson(rootPackage, desktopPackage, { outputDir: '/tmp/release' });
  assert.equal(staged.main, 'desktop/main.mjs');
  assert.equal(staged.type, 'module');
  assert.equal(staged.version, rootPackage.version);
  assert.equal(staged.name, rootPackage.name);
  assert.equal(staged.productName, 'OASIS', 'keeps app data in the same OASIS folder across versions');
  assert.deepEqual(staged.dependencies, rootPackage.dependencies);
  assert.deepEqual(staged.optionalDependencies, rootPackage.optionalDependencies);
  assert.deepEqual(staged.devDependencies, rootPackage.devDependencies, 'npm ci accepts the root lockfile');
  assert.deepEqual(staged.overrides, rootPackage.overrides, 'dependency overrides must match the lockfile too');
  assert.ok(staged.author && staged.author.email, 'deb packages need a maintainer email');
  const build = staged.build;
  assert.equal(build.electronVersion, desktopPackage.devDependencies.electron);
  assert.equal(build.directories.output, '/tmp/release');
  assert.equal(build.publish, null, 'electron-builder never publishes; the release workflow does');
  assert.deepEqual(build.win.target, ['nsis']);
  assert.equal(build.nsis.oneClick, true);
  assert.equal(build.nsis.perMachine, false);
  assert.equal(build.nsis.allowElevation, false);
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.deepEqual(build.mac.target, ['dmg']);
  assert.deepEqual(build.linux.target, ['AppImage', 'deb']);
  assert.ok(build.files.includes('src/**/*') && build.files.includes('app/**/*') && build.files.includes('desktop/**/*'));
  assert.equal(build.npmRebuild, false, 'N-API modules need no Electron rebuild');
  assert.ok(build.asarUnpack.some((glob) => glob.includes('node-pty')), 'the native terminal module loads outside the asar');
  assert.match(build.artifactName, /\$\{arch\}/, 'release assets carry their CPU type for the updater');
});

test('desktop runtime is loopback-only and keeps renderer Node APIs disabled', () => {
  assert.match(desktopMain, /host: '127\.0\.0\.1'/);
  assert.match(desktopMain, /nodeIntegration: false/);
  assert.match(desktopMain, /contextIsolation: true/);
  assert.match(desktopMain, /sandbox: true/);
  assert.match(desktopMain, /startOasisWebServer/);
  assert.match(desktopMain, /previous\.close\(\)/);
  assert.doesNotMatch(desktopMain, /phone/i, 'phone pairing was retired');
});

test('desktop main process hands provider keys to the OS-key-store module', () => {
  assert.match(desktopMain, /createDesktopProviderSecrets\(/);
  assert.match(desktopMain, /secure-secrets\.json/);
  assert.match(desktopMain, /onProviderConfig: persistDesktopProviderConfig/);
  assert.match(desktopMain, /await secrets\(\)\.restore\(\)/);
  assert.match(desktopSecrets, /encryptStringAsync/);
  assert.match(desktopSecrets, /secure storage is unavailable/i);
  assert.match(webRuntime, /await options\.onProviderConfig\(\{ protocol, baseURL, model, apiKey \}\)/);
  assert.match(webRuntime, /await options\.onProviderConfig\(next\)/);
  assert.match(webRuntime, /else await saveConfig\(\{ protocol, baseURL, model, apiKey \}, \{ env \}\)/, 'CLI mode keeps the config-file fallback');
});

test('macOS builds are signed ad hoc without Apple credentials and properly with them', () => {
  const unsigned = desktopPackageJson(rootPackage, desktopPackage, { env: {} }).build.mac;
  assert.equal(unsigned.identity, '-', 'Apple Silicon refuses to run unsigned code');
  assert.equal(unsigned.hardenedRuntime, false);
  assert.equal(unsigned.notarize, false);
  const signed = desktopPackageJson(rootPackage, desktopPackage, { env: { CSC_LINK: 'base64-p12' } }).build.mac;
  assert.equal(signed.identity, undefined, 'electron-builder uses the supplied certificate');
  assert.equal(signed.hardenedRuntime, undefined);
});
