import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [html, robots, sitemap, icon, socialPreview, packageText] = await Promise.all([
  read('../../site/index.html'),
  read('../../site/robots.txt'),
  read('../../site/sitemap.xml'),
  read('../../site/assets/oasis-icon.svg'),
  read('../../site/assets/oasis-social-preview.svg'),
  read('../../package.json')
]);

const expectedUrl = 'https://fahthiz.github.io/oasis/';
const expectedDescription = 'OASIS is an open-source AI coding agent. Bring your own model for local-first coding workflows, tools, and multi-step software work.';
const required = [
  '<!doctype html>', '<html lang="en">', '<meta name="description"',
  'property="og:title"', 'rel="canonical"', 'id="hero-title"',
  'id="features"', 'id="providers"', 'id="safety"', 'id="docs"',
  'https://github.com/FAHTHIZ/oasis/releases/latest', 'no terminal required',
  'https://github.com/FAHTHIZ/oasis', 'docs/USER_GUIDE.md', 'MCP', 'Ollama', 'Apache-2.0',
  'Desktop app (no terminal required)', 'Terminal (for developers)', 'Privacy note',
  'property="og:image"', 'summary_large_image', 'ALPHA'
];
for (const marker of required) assert.ok(html.includes(marker), 'Public homepage is missing: ' + marker);
assert.ok(html.includes(expectedUrl), 'Canonical and social URL should match the Pages URL.');
assert.ok(html.includes('content="' + expectedDescription + '"'), 'Homepage meta description must match the approved concise description.');
assert.ok(html.includes('property="og:image" content="' + expectedUrl + 'assets/oasis-social-preview.svg"'), 'Homepage must point Open Graph at the social preview image.');
assert.ok(socialPreview.includes('width="1200" height="630"') && socialPreview.includes('<svg'), 'Social preview must be a 1200x630 SVG image.');
assert.ok(!/\bMIT\b/i.test(html), 'Homepage must not describe the Apache-licensed project as MIT-licensed.');
assert.ok(!html.includes('There are no native IDE extensions'), 'Homepage limitations must acknowledge the existing VS Code integration.');
assert.ok(html.includes('docs/INSTALL.md') && html.includes('docs/QUICKSTART.md'), 'Homepage must link directly to Install and Quick start.');
assert.ok(html.includes('The desktop app does not require a separate Node.js or Git installation.'), 'Homepage must state that desktop setup needs no runtime installation.');
assert.ok(!html.includes('Just for fun'), 'Homepage must not contain the old repository description.');
assert.ok(!html.includes('award-winning') && !html.includes('100% success'), 'Homepage must not make unsupported credibility claims.');
assert.ok(robots.includes('User-agent: *') && robots.includes('Allow: /'));
assert.ok(robots.includes(expectedUrl + 'sitemap.xml'), 'robots.txt must advertise the sitemap.');
assert.ok(sitemap.includes('<loc>' + expectedUrl + '</loc>'), 'Sitemap URL must match the canonical homepage.');
assert.ok(icon.startsWith('<svg') && icon.includes('</svg>'), 'Homepage favicon must be SVG.');
const pkg = JSON.parse(packageText);
assert.ok(pkg.keywords.includes('ai-coding-agent') && pkg.keywords.includes('agent-skills') && pkg.keywords.includes('ollama'));
assert.ok(expectedDescription.length <= 160, 'Search description should fit a typical snippet length.');
console.log('OASIS public-launch checks passed: landing page metadata, key links, sitemap, robots, favicon, and package discoverability.');
