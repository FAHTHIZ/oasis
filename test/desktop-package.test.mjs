import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const desktopMain = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const installGuide = await readFile(new URL('../docs/INSTALL.md', import.meta.url), 'utf8');

test('desktop packaging defines one-click Windows installer and macOS/Linux packages', () => {
  assert.equal(packageJson.version, '0.3.0');
  assert.equal(packageJson.build.extraMetadata.main, 'desktop/main.mjs');
  assert.equal(packageJson.build.nsis.oneClick, true);
  assert.equal(packageJson.build.nsis.perMachine, false);
  assert.ok(packageJson.build.mac.target.includes('dmg'));
  assert.ok(packageJson.build.linux.target.includes('AppImage'));
  assert.ok(packageJson.build.linux.target.includes('deb'));
  assert.ok(packageJson.files.includes('desktop/'));
  assert.ok(packageJson.dependencies['@xterm/xterm']);
  assert.ok(packageJson.dependencies['@xterm/addon-fit']);
});

test('desktop runtime is loopback-only and keeps renderer Node APIs disabled', () => {
  assert.match(desktopMain, /host: '127\.0\.0\.1'/);
  assert.match(desktopMain, /nodeIntegration: false/);
  assert.match(desktopMain, /contextIsolation: true/);
  assert.match(desktopMain, /sandbox: true/);
  assert.match(desktopMain, /startOasisWebServer/);
  assert.match(desktopMain, /previous\.close\(\)/);
});

test('install instructions explain desktop release and current OS signing limitations', () => {
  assert.match(installGuide, /do not need to install Node\.js or Git/i);
  assert.match(installGuide, /unsigned/i);
  assert.match(installGuide, /releases\/latest/i);
});
