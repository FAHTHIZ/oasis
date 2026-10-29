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

const webRuntime = await readFile(new URL('../src/web.mjs', import.meta.url), 'utf8');
const desktopSecrets = await readFile(new URL('../desktop/secure-secrets.mjs', import.meta.url), 'utf8');

test('desktop stores API keys through Electron OS-backed encryption rather than config plaintext', () => {
  assert.match(desktopMain, /safeStorage/);
  assert.match(desktopMain, /isEncryptionAvailable/);
  assert.match(desktopMain, /secure-secrets\.json/);
  assert.match(desktopMain, /onProviderConfig: persistDesktopProviderConfig/);
  assert.match(desktopMain, /const previousSecret = await loadDesktopApiKey/);
  assert.match(desktopMain, /await saveDesktopApiKey\(previousSecret \|\| ''/);
  assert.match(desktopMain, /saveConfig\(\{ protocol, baseURL, model, apiKey: '' \}/);
  assert.match(desktopMain, /saveConfig\(\{ \.\.\.legacy, apiKey: '' \}/);
  assert.match(webRuntime, /await options\.onProviderConfig\(\{ protocol, baseURL, model, apiKey \}\)/);
  assert.match(desktopSecrets, /encryptString/);
  assert.match(desktopSecrets, /decryptString/);
  assert.match(desktopSecrets, /secure storage is unavailable/i);
  assert.match(webRuntime, /onProviderConfig/);
  assert.match(webRuntime, /await options\.onProviderConfig\(\{ protocol, baseURL, model, apiKey \}\)/);
});

test('local model discovery is loopback-only and uses a fixed Ollama endpoint', () => {
  assert.match(webRuntime, /pathname === '\/api\/provider\/local-models'/);
  assert.match(webRuntime, /if \(!isLoopbackClient\(req\)\)/);
  assert.match(webRuntime, /http:\/\/127\.0\.0\.1:11434\/api\/tags/);
  assert.match(webRuntime, /redirect: 'error'/);
});
