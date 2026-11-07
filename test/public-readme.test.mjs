import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('README describes the actual interfaces and keeps their execution boundaries distinct', async () => {
  const readme = await read('README.md');
  for (const phrase of [
    'CLI and headless runner',
    'Connected browser workspace',
    'Normal browser session',
    'Desktop application',
    'Editor integration',
    'Agent Client Protocol',
    'Node.js SDK',
    'GitHub Action and messaging gateways',
    'does not guarantee that every model will solve every task',
    'Download and install',
    'SHA256SUMS',
    'Windows (.exe)',
    'macOS (.dmg)',
    'Linux (.AppImage / .deb)',
    'Terminal session',
    'Browser workspace',
    'Desktop application',
    'docs/USER-GUIDE.md',
    'docs/RELEASES.md',
    'There is no native Android APK',
    'GitHub Action and messaging gateways',
    'Contributing guide',
    'Support'
  ]) assert.ok(readme.includes(phrase), phrase);
  assert.ok(readme.includes('Approval prompts are not a replacement for operating-system isolation'));
  assert.ok(readme.includes('Apache License 2.0'));
  assert.ok(readme.includes('https://github.com/FAHTHIZ/oasis/releases'));
  assert.ok(readme.includes('oasis web --open'));
  assert.ok(!readme.includes('oasis/app/'));
  assert.ok(!readme.includes('fahthiz.github.io/oasis'));
  assert.ok(readme.startsWith('**Downloads:**'), 'Platform downloads must be the first README content.');
  assert.ok(!/youtube\.com|demo[- ]video/i.test(readme), 'README should use repository-owned demo assets, not external demo-video hosting.');
  assert.ok(readme.includes('assets/demo/oasis-real-model-demo.mp4'));
  assert.ok(readme.includes('assets/demo/oasis-real-model-demo.gif'));
  await stat(path.join(root, 'assets/demo/oasis-real-model-demo.mp4'));
  await stat(path.join(root, 'assets/demo/oasis-real-model-demo.gif'));
});

test('OASIS has one consistent public name and a floor-grounded visual identity', async () => {
  const [readme, brand, hero, icon, logo] = await Promise.all([
    read('README.md'), read('BRAND.md'), read('assets/oasis-readme-hero.svg'),
    read('assets/oasis-icon.svg'), read('assets/oasis-logo.svg')
  ]);
  assert.ok(readme.includes('assets/oasis-readme-hero.svg'));
  assert.ok(readme.includes('Brand guidelines'));
  assert.ok(!/\bOASIS\s+OSS\b/i.test(readme), 'The public product name must remain OASIS.');
  assert.ok(brand.includes('The public-facing product name is OASIS.'));
  assert.ok(brand.includes('Code. Automate. Flourish.'));
  assert.ok(hero.includes('reflective floor') && hero.includes('M0 675L600 444L1200 675'));
  assert.ok(icon.includes('OASIS app icon'));
  assert.ok(logo.includes('OASIS'));
});

test('README relative links resolve to tracked repository files', async () => {
  const readme = await read('README.md');
  const links = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const target of links.filter((value) => !/^[a-z]+:/i.test(value) && !value.startsWith('#'))) {
    const resolved = path.resolve(root, target.split('#')[0]);
    await stat(resolved);
  }
});

test('the user guide and release guide exist and the browser app integrity check has an explicit name', async () => {
  const [userGuide, releasesGuide] = await Promise.all([read('docs/USER-GUIDE.md'), read('docs/RELEASES.md')]);
  assert.ok(userGuide.includes('## 4. Terminal session'));
  assert.ok(userGuide.includes('## 5. Browser workspace'));
  assert.ok(releasesGuide.includes('SHA256SUMS'));
  assert.ok(releasesGuide.includes('Windows'));
  assert.ok(releasesGuide.includes('macOS'));
  assert.ok(releasesGuide.includes('Linux'));
  await stat(path.join(root, 'scripts/check-browser-app.mjs'));
});

test('package manifests do not include deleted documentation or demonstration folders', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.ok(pkg.files.includes('README.md'));
  assert.ok(pkg.files.includes('LICENSE'));
  assert.ok(!pkg.files.includes('docs/'));
  assert.ok(!pkg.files.includes('SECURITY.md'));
  assert.ok(!pkg.files.includes('CONTRIBUTING.md'));
  assert.ok(!pkg.build.files.includes('docs/**/*'));
  assert.ok(!pkg.build.files.some((entry) => entry.includes('demo')));
});
