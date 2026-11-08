import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const desktopMain = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const releaseWorkflow = await readFile(new URL('../.github/workflows/desktop-build.yml', import.meta.url), 'utf8');

test('desktop packaging defines one-click Windows installer and macOS/Linux packages', () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, 'desktop version must be a stable semantic version');
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


test('stable desktop releases require explicit confirmation, channel metadata and same-commit gates', () => {
  assert.ok(releaseWorkflow.includes('publish_release:'));
  assert.ok(releaseWorkflow.includes('confirm_stable_release:'));
  assert.ok(releaseWorkflow.includes('inputs.publish_release == true'));
  assert.ok(releaseWorkflow.includes('inputs.confirm_stable_release == true'));
  const condition = releaseWorkflow.slice(releaseWorkflow.indexOf('publish-release:'), releaseWorkflow.indexOf('needs:', releaseWorkflow.indexOf('publish-release:')));
  assert.ok(condition.includes("github.event_name == 'push'"));
  assert.ok(condition.includes("github.ref == 'refs/heads/main'"));
  assert.ok(releaseWorkflow.includes('oasisRelease?.channel'));
  assert.ok(releaseWorkflow.includes('must be stable'));
  assert.ok(releaseWorkflow.includes('already released from'), 'an existing tag is never overwritten');
  assert.ok(releaseWorkflow.includes('generate_release_notes: true'));
  assert.ok(!releaseWorkflow.includes('docs/releases') && !releaseWorkflow.includes('body_path:'));
  assert.ok(releaseWorkflow.includes('quality.yml installer-checks.yml'), 'same-commit quality gates must pass first');
});
test('desktop runtime is loopback-only and keeps renderer Node APIs disabled', () => {
  assert.match(desktopMain, /host: '127\.0\.0\.1'/);
  assert.match(desktopMain, /nodeIntegration: false/);
  assert.match(desktopMain, /contextIsolation: true/);
  assert.match(desktopMain, /sandbox: true/);
  assert.match(desktopMain, /startOasisWebServer/);
  assert.match(desktopMain, /previous\.close\(\)/);
});

test('desktop packaging does not depend on removed documentation files', () => {
  assert.ok(packageJson.files.includes('README.md'));
  assert.ok(packageJson.files.includes('LICENSE'));
  assert.ok(!packageJson.files.includes('docs/'));
  assert.ok(!packageJson.files.includes('SECURITY.md'));
  assert.ok(!packageJson.files.includes('CONTRIBUTING.md'));
  assert.ok(!packageJson.build.files.includes('docs/**/*'));
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
  assert.match(desktopMain, /saveConfig\(\{ protocol, baseURL, model, apiKey: '',/);
  assert.match(desktopMain, /saveConfig\(\{ \.\.\.legacy, apiKey: '' \}/);
  assert.match(webRuntime, /await options\.onProviderConfig\(\{ protocol, baseURL, model, apiKey \}\)/);
  assert.match(desktopSecrets, /encryptString/);
  assert.match(desktopSecrets, /decryptString/);
  assert.match(desktopSecrets, /secure storage is unavailable/i);
  assert.match(webRuntime, /onProviderConfig/);
  assert.match(webRuntime, /await saveConfig\(\{ protocol, baseURL, model, apiKey \}, \{ env \}\)/, 'Non-desktop mode keeps its config-file provider setup fallback.');
});

test('local model discovery is loopback-only and uses a fixed Ollama endpoint', () => {
  assert.match(webRuntime, /pathname === '\/api\/provider\/local-models'/);
  assert.match(webRuntime, /if \(!isLoopbackClient\(req\)\)/);
  assert.match(webRuntime, /http:\/\/127\.0\.0\.1:11434\/api\/tags/);
  assert.match(webRuntime, /redirect: 'error'/);
});
