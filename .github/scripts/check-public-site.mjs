import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [html, robots, sitemap, icon, packageText, licenseText] = await Promise.all([
  read('../../site/index.html'),
  read('../../site/robots.txt'),
  read('../../site/sitemap.xml'),
  read('../../site/assets/oasis-icon.svg'),
  read('../../package.json'),
  read('../../LICENSE')
]);

const expectedUrl = 'https://fahthiz.github.io/oasis/';
const expectedRepoUrl = 'https://github.com/FAHTHIZ/oasis.git';
const expectedDescription = 'OASIS is an open-source, local-first agentic development workspace for coding, automation, and verification.';
const required = [
  '<!doctype html>', '<html lang="en">', '<meta name="description"',
  'property="og:title"', 'rel="canonical"', 'id="hero-title"',
  'id="features"', 'id="providers"', 'id="safety"', 'id="docs"',
  'https://github.com/FAHTHIZ/oasis/releases', 'no terminal required',
  'Download OASIS 1.0', 'Install the CLI', 'https://github.com/FAHTHIZ/oasis/releases/latest', 'Download the latest release',
  'https://github.com/FAHTHIZ/oasis', 'MCP', 'Ollama', 'Apache-2.0',
  'Desktop app (no terminal required)', 'Universal app (phone, tablet, any computer)', 'Open the app', 'href="app/"', 'Terminal (for developers)', 'Privacy note',
  'OASIS 1.0 · Stable · Open source · Apache-2.0'
];
// Visible text can contain inline icons (for example a link arrow), so text markers also match the tag-free copy.
const visibleText = html.replace(/<[^>]+>/g, '');
for (const marker of required) assert.ok(html.includes(marker) || visibleText.includes(marker), 'Public homepage is missing: ' + marker);
const heroStart = html.indexOf('<div class="hero-actions">');
const heroEnd = heroStart >= 0 ? html.indexOf('</div>', heroStart) : -1;
const heroActions = heroStart >= 0 && heroEnd >= 0 ? html.slice(heroStart, heroEnd + '</div>'.length) : '';
assert.ok(
  heroActions.includes('href="https://github.com/FAHTHIZ/oasis/releases/latest"') &&
  heroActions.includes('Download OASIS 1.0'),
  'The primary homepage action must lead to the latest published release.'
);
assert.ok(
  heroActions.includes('href="#install-cmd"') && html.includes('id="install-cmd"') &&
  heroActions.includes('Install the CLI'),
  'The secondary action must lead to the install command.'
);
assert.ok(!/release candidate|\bRC1\b|1\.0 RC/i.test(html), 'Homepage must not describe 1.0 as a release candidate.');
assert.ok(html.includes(expectedUrl), 'Canonical and social URL should match the Pages URL.');
assert.ok(html.includes('content="' + expectedDescription + '"'), 'Homepage meta description must match the approved concise description.');
// Every repository file and site asset the page links to must exist, so deleting a file cannot leave a dead link.
for (const [, url] of html.matchAll(/(?:href|src|poster|content)="([^"]+)"/g)) {
  const repoPath = (url.match(/^https:\/\/github\.com\/FAHTHIZ\/oasis\/(?:blob|tree)\/main\/([^#?]+)/) || [])[1];
  const sitePath = (url.match(/^(?:https:\/\/fahthiz\.github\.io\/oasis\/)?(assets\/[^#?"]+)$/) || [])[1];
  const target = repoPath ? '../../' + repoPath : sitePath ? '../../site/' + sitePath : '';
  if (target) assert.ok(existsSync(new URL(target, import.meta.url)), 'Homepage links to a missing file: ' + url);
}
for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) {
  if (!anchor.startsWith('i-')) assert.ok(html.includes('id="' + anchor + '"'), 'Homepage links to a missing section: #' + anchor);
}
assert.ok(html.includes('OASIS 1.0 · Stable · Open source · Apache-2.0'), 'Public homepage must show the stable 1.0 lifecycle.');
assert.ok(!/\bMIT\b/i.test(html), 'Homepage must not describe the Apache-licensed project as MIT-licensed.');
assert.ok(!html.includes('There are no native IDE extensions'), 'Homepage limitations must acknowledge the existing VS Code integration.');
assert.ok(html.includes('unsigned') && html.includes('SHA-256 checksums'), 'Homepage must state that installers are unsigned and checksum-verified.');
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
assert.match(pkg.version, /^1\.\d+\.\d+$/, 'The desktop package must retain numeric stable 1.x SemVer.');
assert.equal(pkg.oasisRelease?.channel, 'stable', 'The package must carry the stable channel.');
assert.equal(pkg.oasisRelease?.candidate, undefined, 'A stable package must not carry a candidate number.');
assert.equal(pkg.oasisRelease?.stableTag, 'v' + pkg.version, 'The package must identify the intended stable tag.');
console.log('OASIS public-site checks passed: metadata, links, stable 1.0 branding, canonical repo, and Apache-2.0 license consistency.');
