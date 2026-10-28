import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [html, robots, sitemap, icon, packageText] = await Promise.all([
  read('../site/index.html'),
  read('../site/robots.txt'),
  read('../site/sitemap.xml'),
  read('../site/assets/oasis-icon.svg'),
  read('../package.json')
]);

const expectedUrl = 'https://fahthiz.github.io/oasis/';
const expectedDescription = 'OASIS is an open-source AI coding agent and local-first developer workspace with a CLI, multi-provider models, MCP tools, skills, and subagents.';
const required = [
  '<!doctype html>', '<html lang="en">', '<meta name="description"',
  'property="og:title"', 'rel="canonical"', 'id="hero-title"',
  'id="features"', 'id="providers"', 'id="safety"', 'id="docs"',
  'npm install -g git+https://github.com/FAHTHIZ/oasis.git#main',
  'https://github.com/FAHTHIZ/oasis', 'docs/USER_GUIDE.md', 'MCP', 'Ollama', 'MIT licensed'
];
for (const marker of required) assert.ok(html.includes(marker), 'Public homepage is missing: ' + marker);
assert.ok(html.includes(expectedUrl), 'Canonical and social URL should match the Pages URL.');
assert.ok(html.includes('Node.js 22+'), 'Homepage must state the runtime requirement.');
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
