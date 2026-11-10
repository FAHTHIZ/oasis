import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('README describes the two interfaces, honest limits and verifiable downloads', async () => {
  const readme = await read('README.md');
  for (const phrase of [
    '## Two ways to work',
    'Terminal',
    'Web app',
    'oasis web --open',
    'Agent Client Protocol',
    'Node.js SDK',
    'GitHub Action',
    'does not guarantee that every model will solve every task',
    'Approval prompts are not a replacement for operating-system isolation',
    'SHA256SUMS',
    'optional [desktop app](docs/DESKTOP.md)',
    'there is no separate mobile app',
    'docs/RELEASES.md',
    'docs/INTERFACES.md',
    'Contributing guide',
    'Support',
    'Apache License 2.0'
  ]) assert.ok(readme.includes(phrase), phrase);
  assert.ok(readme.includes('https://github.com/FAHTHIZ/oasis/releases'));
  assert.ok(!readme.includes('oasis/app/'));
  assert.ok(!readme.includes('fahthiz.github.io/oasis'));
  assert.ok(!/npm install -g oasis-oss|npx oasis-oss/.test(readme), 'oasis-oss is not published on npm');
  assert.ok(!/youtube\.com|demo[- ]video/i.test(readme), 'README should use repository-owned demo assets, not external demo-video hosting.');
  assert.ok(readme.includes('assets/demo/oasis-real-model-demo.mp4'));
  assert.ok(readme.includes('assets/demo/oasis-real-model-demo.gif'));
  await stat(path.join(root, 'assets/demo/oasis-real-model-demo.mp4'));
  await stat(path.join(root, 'assets/demo/oasis-real-model-demo.gif'));
  for (const [, image] of readme.matchAll(/<img[^>]+src="(assets\/[^"]+)"/g)) await stat(path.join(root, image));
});

test('the user guide and release guide exist and the web app has a browser end-to-end check', async () => {
  const [userGuide, releasesGuide] = await Promise.all([read('docs/USER-GUIDE.md'), read('docs/RELEASES.md')]);
  assert.ok(userGuide.includes('## 4. Terminal session'));
  assert.ok(userGuide.includes('## 5. Browser workspace'));
  assert.ok(releasesGuide.includes('SHA256SUMS'));
  assert.ok(releasesGuide.includes('Windows'));
  assert.ok(releasesGuide.includes('[desktop app](DESKTOP.md)'), 'the release guide points to the desktop guide');
  assert.match(releasesGuide, /desktop installers[^\n]*SHA256SUMS/, 'every installer is covered by SHA256SUMS');
  const desktopGuide = await read('docs/DESKTOP.md');
  for (const fact of ['xattr -dr com.apple.quarantine', 'SmartScreen', 'not signed', 'sudo apt remove oasis-desktop', 'SHA256SUMS']) {
    assert.ok(desktopGuide.includes(fact), fact);
  }
  await stat(path.join(root, '.github/scripts/browser-e2e.mjs'));
});

test('package manifests do not include deleted documentation or demonstration folders', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.ok(pkg.files.includes('README.md'));
  assert.ok(pkg.files.includes('LICENSE'));
  assert.ok(!pkg.files.includes('docs/'));
  assert.ok(!pkg.files.includes('SECURITY.md'));
  assert.ok(!pkg.files.includes('CONTRIBUTING.md'));
  assert.equal(pkg.build, undefined, 'no desktop packaging config');
  assert.ok(!pkg.files.includes('desktop/'));
});
