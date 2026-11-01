import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [html, robots, sitemap, icon, socialPreview, packageText, readme, licenseText, rcSticker, rcSeal, rcMark] = await Promise.all([
  read('../../site/index.html'),
  read('../../site/robots.txt'),
  read('../../site/sitemap.xml'),
  read('../../site/assets/oasis-icon.svg'),
  read('../../site/assets/oasis-social-preview.svg'),
  read('../../package.json'),
  read('../../README.md'),
  read('../../LICENSE'),
  read('../../assets/oasis-rc-sticker.svg'),
  read('../../assets/oasis-rc-seal.svg'),
  read('../../assets/oasis-rc-mark.svg')
]);

const expectedUrl = 'https://fahthiz.github.io/oasis/';
const expectedRepoUrl = 'https://github.com/FAHTHIZ/oasis.git';
const expectedDescription = 'OASIS is an open-source, local-first agentic development workspace for coding, automation, and verification.';
const required = [
  '<!doctype html>', '<html lang="en">', '<meta name="description"',
  'property="og:title"', 'rel="canonical"', 'id="hero-title"',
  'id="features"', 'id="providers"', 'id="safety"', 'id="docs"',
  'https://github.com/FAHTHIZ/oasis/releases', 'https://github.com/FAHTHIZ/oasis/blob/main/docs/TERMUX.md', 'no terminal required',
  'Download stable v0.4.0', 'Try 1.0 RC1 from source', 'https://github.com/FAHTHIZ/oasis/releases/tag/v0.4.0', 'Download OASIS v0.4.0', 'docs/INSTALL.md#run-the-current-release-candidate-from-source',
  'https://github.com/FAHTHIZ/oasis', 'docs/USER_GUIDE.md', 'MCP', 'Ollama', 'Apache-2.0',
  'Desktop app (no terminal required)', 'Android / Termux installation', 'No native Android APK is published yet.', 'Terminal (for developers)', 'Privacy note',
  'property="og:image"', 'summary_large_image', 'Feature-complete 1.0 RC · Open source · Apache-2.0', '1.0.0', 'docs/PROJECT_PLAN.md'
];
for (const marker of required) assert.ok(html.includes(marker), 'Public homepage is missing: ' + marker);
const heroStart = html.indexOf('<div class="hero-actions">');
const heroEnd = heroStart >= 0 ? html.indexOf('</div>', heroStart) : -1;
const heroActions = heroStart >= 0 && heroEnd >= 0 ? html.slice(heroStart, heroEnd + '</div>'.length) : '';
assert.ok(
  heroActions.includes('href="https://github.com/FAHTHIZ/oasis/releases/tag/v0.4.0"') &&
  heroActions.includes('Download stable v0.4.0'),
  'The primary homepage action must lead to the actual published stable desktop/CLI release.'
);
assert.ok(
  heroActions.includes('href="https://github.com/FAHTHIZ/oasis/blob/main/docs/INSTALL.md#run-the-current-release-candidate-from-source"') &&
  heroActions.includes('Try 1.0 RC1 from source'),
  'The RC action must lead to the documented source-install path, not the stable releases page.'
);
assert.ok(html.includes(expectedUrl), 'Canonical and social URL should match the Pages URL.');
assert.ok(html.includes('content="' + expectedDescription + '"'), 'Homepage meta description must match the approved concise description.');
assert.ok(html.includes('property="og:image" content="' + expectedUrl + 'assets/oasis-social-preview.svg"'), 'Homepage must point Open Graph at the social preview image.');
assert.ok(socialPreview.includes('width="1200" height="630"') && socialPreview.includes('<svg'), 'Social preview must be a 1200x630 SVG image.');
assert.ok(socialPreview.includes('OASIS') && !socialPreview.includes('OASIS OSS') && socialPreview.includes('CODE. AUTOMATE.') && socialPreview.includes('local-first workspace'), 'Social preview must use the current OASIS-only product identity and descriptor.');
assert.ok(html.includes('Feature-complete 1.0 RC · Open source · Apache-2.0'), 'Public homepage must show the current release-candidate lifecycle.');
for (const [name, sticker, marker] of [['wide RC sticker', rcSticker, 'RELEASE CANDIDATE'], ['round RC seal', rcSeal, 'RC 1'], ['compact RC mark', rcMark, 'RC1']]) {
  assert.ok(sticker.startsWith('<svg') && sticker.includes('</svg>'), name + ' must be an SVG document.');
  assert.ok(sticker.includes(marker), name + ' must visibly identify the release-candidate stage.');
  assert.ok(!sticker.includes('BETA'), name + ' must not retain the old Beta label.');
}
assert.ok(!/\bMIT\b/i.test(html), 'Homepage must not describe the Apache-licensed project as MIT-licensed.');
assert.ok(!html.includes('There are no native IDE extensions'), 'Homepage limitations must acknowledge the existing VS Code integration.');
assert.ok(html.includes('docs/INSTALL.md') && html.includes('docs/USER_GUIDE.md'), 'Homepage must link directly to Install and the detailed User Guide.');
assert.ok(html.includes('latest published stable desktop installers remain v0.4.0') && html.includes('unsigned') && html.includes('clean-machine installation checks remain a release gate') && html.includes('1.0.0 Release Candidate 1'), 'Homepage must distinguish the historical stable v0.4.0 downloads from the unpublished 1.0.0 Release Candidate 1 source snapshot.');
assert.ok(/The packaged app does not require a separate Node\.js or Git installation/i.test(html), 'Homepage must explain that the packaged desktop app includes its own runtime.');
assert.ok(html.includes('grid-template-columns:repeat(3,minmax(0,1fr))') && html.includes('@media(max-width:850px){.install-choices{grid-template-columns:repeat(2,minmax(0,1fr))}') && html.includes('@media(max-width:560px){.install-choices{grid-template-columns:1fr}'), 'Platform choices must fit desktop, tablet, and mobile layouts.');
assert.ok(!html.includes('Just for fun'), 'Homepage must not contain the old repository description.');
assert.ok(!html.includes('award-winning') && !html.includes('100% success'), 'Homepage must not make unsupported credibility claims.');
assert.ok(robots.includes('User-agent: *') && robots.includes('Allow: /'));
assert.ok(robots.includes(expectedUrl + 'sitemap.xml'), 'robots.txt must advertise the sitemap.');
assert.ok(sitemap.includes('<loc>' + expectedUrl + '</loc>'), 'Sitemap URL must match the canonical homepage.');
assert.ok(icon.startsWith('<svg') && icon.includes('</svg>'), 'Homepage favicon must be SVG.');

const pkg = JSON.parse(packageText);
assert.equal(pkg.license, 'Apache-2.0', 'package.json must declare Apache-2.0 as the project license.');
assert.equal(pkg.repository?.url, expectedRepoUrl, 'package.json must point to the canonical FAHTHIZ/oasis repository.');
assert.ok(pkg.keywords.includes('ai-coding-agent') && pkg.keywords.includes('agent-skills') && pkg.keywords.includes('ollama'));
assert.ok(!readme.includes('gtxnrg-ship-it/oasis'), 'README must not contain links to the old gtxnrg-ship-it/oasis repository.');
assert.ok(readme.includes('https://github.com/FAHTHIZ/oasis') && readme.includes('license-Apache--2.0-blue.svg'), 'README must link to the canonical repository and show the Apache-2.0 badge.');
assert.ok(readme.includes('Apache License 2.0 — see [LICENSE](LICENSE).'), 'README must explain where to find the Apache-2.0 license.');
assert.ok(
  licenseText.startsWith('                                 Apache License\n                           Version 2.0, January 2004') &&
  licenseText.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION') &&
  licenseText.includes('9. Accepting Warranty or Additional Liability.') &&
  licenseText.includes('END OF TERMS AND CONDITIONS') &&
  licenseText.includes('APPENDIX: How to apply the Apache License to your work.') &&
  licenseText.includes('http://www.apache.org/licenses/LICENSE-2.0'),
  'LICENSE must contain the full Apache License 2.0 text, including its terms and appendix.'
);
assert.ok(expectedDescription.length <= 160, 'Search description should fit a typical snippet length.');
assert.equal(pkg.version, '1.0.0', 'The desktop package must retain numeric stable SemVer.');
assert.equal(pkg.oasisRelease?.channel, 'release-candidate', 'The package must carry the RC channel separately from SemVer.');
assert.equal(pkg.oasisRelease?.candidate, 1, 'The package must identify Release Candidate 1.');
assert.equal(pkg.oasisRelease?.stableTag, 'v1.0.0', 'The package must identify the intended stable tag.');
assert.ok(readme.includes('1.0.0') && readme.includes('Release Candidate'), 'README must describe the current candidate lifecycle.');
console.log('OASIS public-site checks passed: metadata, links, 1.0 release-candidate branding, canonical repo, and Apache-2.0 license consistency.');
