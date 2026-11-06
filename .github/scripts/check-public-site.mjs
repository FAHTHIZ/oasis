import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [html, robots, sitemap, icon, packageText, readme, licenseText] = await Promise.all([
  read('../../site/index.html'),
  read('../../site/robots.txt'),
  read('../../site/sitemap.xml'),
  read('../../site/assets/oasis-icon.svg'),
  read('../../package.json'),
  read('../../README.md'),
  read('../../LICENSE')
]);

const expectedUrl = 'https://fahthiz.github.io/oasis/';
const appUrl = expectedUrl + 'app/';
assert.ok(html.includes('<!doctype html>') && html.includes('<html lang="en">'));
assert.ok(html.includes('http-equiv="refresh" content="0;url=app/"'), 'The public root must redirect to the application.');
assert.ok(html.includes("location.replace('app/')") && html.includes('href="app/"'), 'The redirect must have a script and a manual fallback link.');
assert.ok(html.includes('rel="canonical" href="' + appUrl + '"'), 'The canonical URL must point to the app.');
assert.ok(html.includes('<!--OASIS:CHANGES-->') && html.includes('<!--/OASIS:CHANGES-->'));
assert.ok(html.includes('<!--OASIS:BUILD-->') && html.includes('<!--/OASIS:BUILD-->'));
assert.ok(!html.includes('docs/') && !html.includes('oasis-social-preview') && !html.includes('oasis-readme'), 'The redirect page must not link to removed documents or obsolete promotional assets.');
assert.ok(robots.includes('User-agent: *') && robots.includes('Allow: /'));
assert.ok(robots.includes(expectedUrl + 'sitemap.xml'));
assert.ok(sitemap.includes('<loc>' + expectedUrl + '</loc>'));
assert.ok(icon.startsWith('<svg') && icon.includes('</svg>'));

const pkg = JSON.parse(packageText);
assert.equal(pkg.license, 'Apache-2.0');
assert.equal(pkg.repository?.url, 'https://github.com/FAHTHIZ/oasis.git');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.ok(readme.includes('coding-agent runtime') && readme.includes('npm run check'));
assert.ok(readme.includes('Apache License 2.0'));
assert.ok(!readme.includes('beats Claude Code') && !readme.includes('100% success') && !readme.includes('security certified'));
assert.ok(licenseText.includes('Apache License') && licenseText.includes('Version 2.0, January 2004'));
assert.ok(licenseText.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
assert.ok(licenseText.includes('APPENDIX: How to apply the Apache License'));
console.log('OASIS public deployment checks passed: app redirect, metadata, source-grounded README and Apache-2.0 license.');
